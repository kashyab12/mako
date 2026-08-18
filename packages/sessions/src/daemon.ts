/**
 * The sync daemon: the catalog, running whether or not any window is open.
 *
 * Everything the catalog does — watching five harnesses' stores, peeking
 * changed files, polling remotes — works headless, because the library was
 * built without Electron in it. This wraps one catalog in a Unix-socket
 * server so that *one* process owns the watchers and the peek cache, and
 * every client — the desktop app, a CLI, the next thing — reads the same
 * always-warm state over NDJSON instead of scanning disk themselves.
 *
 * What this buys, concretely: the app's boot goes from "scan the world"
 * to one socket round-trip; the cache never goes cold because the daemon
 * was watching while the app was closed; and two windows cost two socket
 * connections, not two sets of file watchers.
 *
 * The protocol is deliberately small — NDJSON frames on a local socket:
 *
 *   → { id, op: "ping" | "list" | "open" | "follow" | "unfollow", ... }
 *   ← { id, ok, result | error }            responses
 *   ← { event: "added"|"updated"|"removed", ... }   catalog changes
 *   ← { event: "entries", path, entries, replace }  followed-thread tails
 *
 * Single instance by construction: a starting daemon first tries to *be* a
 * client; if something answers the ping, it exits quietly.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net"
import { unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionCatalog } from "./catalog.js"
import type { Thread, ThreadEntry, ThreadRef } from "./format.js"

export function daemonSocketPath(): string {
  return join(homedir(), ".mako", "syncd.sock")
}

export interface DaemonStats {
  pid: number
  startedAt: number
  sessions: number
  version: number
}

interface Frame {
  id?: number
  op?: string
  path?: string
  fromByte?: number
  cwd?: string
  harness?: string
}

const PROTOCOL_VERSION = 1

/** Serve one catalog over the socket. Resolves once listening. */
export async function serveCatalog(
  catalog: SessionCatalog,
  socketPath = daemonSocketPath()
): Promise<Server> {
  // If a daemon already answers, this one has no job.
  const alive = await pingDaemon(socketPath).catch(() => null)
  if (alive) throw new Error(`A sync daemon is already running (pid ${alive.pid})`)
  await unlink(socketPath).catch(() => {}) // A stale socket from a dead process.

  const startedAt = Date.now()
  const clients = new Set<Socket>()
  const follows = new Map<Socket, Map<string, () => void>>()

  const broadcast = (message: object) => {
    const line = `${JSON.stringify(message)}\n`
    for (const client of clients) client.write(line)
  }

  catalog.onEvent((event) => broadcast({ event: event.type, ...event }))

  const server = createServer((socket) => {
    clients.add(socket)
    follows.set(socket, new Map())
    let buffer = ""

    const reply = (id: number | undefined, ok: boolean, payload: unknown) => {
      socket.write(`${JSON.stringify({ id, ok, ...(ok ? { result: payload } : { error: String(payload) }) })}\n`)
    }

    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let frame: Frame
        try {
          frame = JSON.parse(raw) as Frame
        } catch {
          continue
        }
        void handle(frame)
      }
    })

    const handle = async (frame: Frame) => {
      try {
        switch (frame.op) {
          case "ping":
            reply(frame.id, true, {
              pid: process.pid,
              startedAt,
              sessions: catalog.list().length,
              version: PROTOCOL_VERSION,
            } satisfies DaemonStats)
            return
          case "list":
            reply(frame.id, true, catalog.list({ cwd: frame.cwd, harness: frame.harness }))
            return
          case "open": {
            if (!frame.path) throw new Error("open needs a path")
            reply(frame.id, true, await catalog.open(frame.path))
            return
          }
          case "follow": {
            if (!frame.path) throw new Error("follow needs a path")
            const mine = follows.get(socket)
            mine?.get(frame.path)?.()
            const stop = catalog.follow(frame.path, frame.fromByte ?? 0, (entries, replaced) => {
              socket.write(
                `${JSON.stringify({ event: "entries", path: frame.path, entries, replace: replaced })}\n`
              )
            })
            mine?.set(frame.path, stop)
            reply(frame.id, true, null)
            return
          }
          case "unfollow": {
            const mine = follows.get(socket)
            if (frame.path) {
              mine?.get(frame.path)?.()
              mine?.delete(frame.path)
            } else {
              for (const stop of mine?.values() ?? []) stop()
              mine?.clear()
            }
            reply(frame.id, true, null)
            return
          }
          default:
            throw new Error(`Unknown op: ${frame.op}`)
        }
      } catch (error) {
        reply(frame.id, false, error instanceof Error ? error.message : String(error))
      }
    }

    const cleanup = () => {
      clients.delete(socket)
      for (const stop of follows.get(socket)?.values() ?? []) stop()
      follows.delete(socket)
    }
    socket.on("close", cleanup)
    socket.on("error", cleanup)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  return server
}

/* ------------------------------------------------------------ client */

export interface DaemonClient {
  stats: DaemonStats
  list(filter?: { cwd?: string; harness?: string }): Promise<ThreadRef[]>
  open(path: string): Promise<Thread | null>
  follow(path: string, fromByte: number): Promise<void>
  unfollow(path?: string): Promise<void>
  onEvent(
    listener: (event:
      | { event: "added" | "updated"; ref: ThreadRef }
      | { event: "removed"; path: string }
      | { event: "entries"; path: string; entries: ThreadEntry[]; replace?: boolean }
    ) => void
  ): () => void
  /** Fires once if the daemon goes away; the client is dead afterwards. */
  onClose(listener: () => void): void
  close(): void
}

/** One request, no session kept: proof of life and the stats that ride on it. */
export async function pingDaemon(socketPath = daemonSocketPath()): Promise<DaemonStats> {
  const client = await connectDaemon(socketPath, 1500)
  const stats = client.stats
  client.close()
  return stats
}

export async function connectDaemon(
  socketPath = daemonSocketPath(),
  timeoutMs = 3000
): Promise<DaemonClient> {
  const socket = createConnection(socketPath)
  socket.setNoDelay(true)

  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const eventListeners = new Set<(event: never) => void>()
  const closeListeners = new Set<() => void>()
  let buffer = ""

  socket.on("data", (chunk) => {
    buffer += chunk.toString()
    let at: number
    while ((at = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let frame: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string }
      try {
        frame = JSON.parse(raw) as typeof frame
      } catch {
        continue
      }
      if (frame.id !== undefined) {
        const waiter = pending.get(frame.id)
        pending.delete(frame.id)
        if (waiter) {
          if (frame.ok) waiter.resolve(frame.result)
          else waiter.reject(new Error(frame.error ?? "daemon error"))
        }
      } else if (frame.event) {
        for (const listener of eventListeners) listener(frame as never)
      }
    }
  })

  const dead = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("The sync daemon went away"))
    pending.clear()
    for (const listener of closeListeners) listener()
    closeListeners.clear()
  }
  socket.on("close", dead)
  socket.on("error", () => socket.destroy())

  const request = <T>(frame: object): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      socket.write(`${JSON.stringify({ id, ...frame })}\n`)
    })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The sync daemon did not answer")), timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  const stats = await request<DaemonStats>({ op: "ping" })

  return {
    stats,
    list: (filter) => request({ op: "list", ...filter }),
    open: (path) => request({ op: "open", path }),
    follow: (path, fromByte) => request({ op: "follow", path, fromByte }),
    unfollow: (path) => request({ op: "unfollow", path }),
    onEvent: (listener) => {
      eventListeners.add(listener as (event: never) => void)
      return () => eventListeners.delete(listener as (event: never) => void)
    },
    onClose: (listener) => void closeListeners.add(listener),
    close: () => socket.destroy(),
  }
}
