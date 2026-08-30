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

import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { dirname, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import type { SessionCatalog } from "./catalog.js"
import {
  parseDaemonEvent,
  parseDaemonRequest,
  parseDaemonResponse,
  parseJsonRecord,
  readDaemonFrameId,
  serializeDaemonFrame,
  type DaemonEvent,
  type DaemonRequestFrame,
  type DaemonResponseFrame,
  type DaemonStats,
  type PendingRequest,
} from "./daemon-wire.js"
import type { Thread, ThreadPage, ThreadRef } from "./format.js"

export type { DaemonEvent, DaemonStats } from "./daemon-wire.js"

export function daemonSocketPath(): string {
  if (process.platform === "win32") {
    const user = (process.env.USERNAME ?? "user").replace(/[^a-z0-9_-]/gi, "-")
    return `\\\\.\\pipe\\mako-syncd-${user}`
  }
  return join(homedir(), ".mako", "syncd.sock")
}

/**
 * Bumped when the wire *data* changes shape, not just the ops — a ref that
 * grew a field counts, because a stale daemon would keep serving refs
 * without it forever. Clients that see an older daemon retire it and let a
 * fresh one take the socket.
 */
export const PROTOCOL_VERSION = 28
export const MAX_DAEMON_RSS = 512 * 1024 * 1024
export function daemonMemoryUnsafe(rss: number): boolean {
  return rss > MAX_DAEMON_RSS
}
const MAX_CLIENTS = 64
const MAX_REQUEST_FRAME_BYTES = 1024 * 1024
const MAX_RESPONSE_FRAME_BYTES = 256 * 1024 * 1024
const MAX_PENDING_WRITE_BYTES = 256 * 1024 * 1024

export interface DaemonClaim {
  release(): Promise<void>
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function claimDaemon(
  socketPath = daemonSocketPath()
): Promise<DaemonClaim> {
  const lockPath =
    process.platform === "win32"
      ? join(homedir(), ".mako", "syncd.lock")
      : `${socketPath}.lock`
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      })
      let released = false
      return {
        async release() {
          if (released) return
          released = true
          const owner = Number(await readFile(lockPath, "utf8").catch(() => ""))
          if (owner === process.pid) await unlink(lockPath).catch(() => {})
        },
      }
    } catch (error) {
      let owner = Number(await readFile(lockPath, "utf8").catch(() => ""))
      if (!Number.isInteger(owner) || owner <= 0) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        owner = Number(await readFile(lockPath, "utf8").catch(() => ""))
      }
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
        throw new Error(`A sync daemon is already starting (pid ${owner})`)
      }
      await unlink(lockPath).catch(() => {})
      if (attempt === 1) throw error
    }
  }
  throw new Error("The sync daemon lock could not be acquired")
}

function writeFrame(socket: Socket, frame: string): void {
  if (socket.destroyed) return
  if (
    socket.writableLength + Buffer.byteLength(frame) >
    MAX_PENDING_WRITE_BYTES
  ) {
    socket.destroy(new Error("The sync daemon client stopped reading"))
    return
  }
  socket.write(frame)
}

/** Serve one catalog over the socket. Resolves once listening. */
export async function serveCatalog(
  catalog: SessionCatalog,
  socketPath = daemonSocketPath(),
  claim?: DaemonClaim
): Promise<Server> {
  const ownership = claim ?? (await claimDaemon(socketPath))
  const alive = await pingDaemon(socketPath).catch(() => null)
  if (alive) {
    await ownership.release()
    throw new Error(`A sync daemon is already running (pid ${alive.pid})`)
  }
  if (process.platform !== "win32") await unlink(socketPath).catch(() => {})

  const startedAt = Date.now()
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  eventLoopDelay.enable()
  const clients = new Set<Socket>()
  const follows = new Map<Socket, Map<string, () => void>>()

  const broadcast = (frame: DaemonEvent) => {
    const line = serializeDaemonFrame(frame)
    for (const client of clients) writeFrame(client, line)
  }

  const stopEvents = catalog.onEvent((event) => {
    if (event.type === "removed") {
      broadcast({ event: "removed", path: event.path })
      return
    }
    broadcast({ event: event.type, ref: event.ref })
  })

  const server = createServer((socket) => {
    if (clients.size >= MAX_CLIENTS) {
      socket.destroy(new Error("The sync daemon has too many clients"))
      return
    }
    clients.add(socket)
    follows.set(socket, new Map())
    let buffer = ""
    const decoder = new StringDecoder("utf8")

    const reply = (frame: DaemonResponseFrame) => {
      writeFrame(socket, serializeDaemonFrame(frame))
    }

    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk)
      let at: number
      while ((at = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (Buffer.byteLength(raw) > MAX_REQUEST_FRAME_BYTES) {
          socket.destroy(new Error("The sync daemon request was too large"))
          return
        }
        const frame = parseDaemonRequest(raw)
        if (frame) void handle(frame)
      }
      if (Buffer.byteLength(buffer) > MAX_REQUEST_FRAME_BYTES) {
        socket.destroy(new Error("The sync daemon request was too large"))
      }
    })

    const handle = async (frame: DaemonRequestFrame) => {
      try {
        switch (frame.op) {
          case "ping": {
            const memory = process.memoryUsage()
            reply({
              id: frame.id,
              ok: true,
              result: {
                pid: process.pid,
                startedAt,
                sessions: catalog.list().length,
                version: PROTOCOL_VERSION,
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                eventLoopP99Ms: Number(eventLoopDelay.percentile(99)) / 1_000_000,
              },
            })
            return
          }
          case "list":
            reply({
              id: frame.id,
              ok: true,
              result: catalog.list({ cwd: frame.cwd, harness: frame.harness }),
            })
            return
          case "open":
            reply({
              id: frame.id,
              ok: true,
              result: await catalog.open(frame.path),
            })
            return
          case "page":
            reply({
              id: frame.id,
              ok: true,
              result: await catalog.page(frame.path, frame.before, frame.limit),
            })
            return
          case "follow": {
            const mine = follows.get(socket)
            mine?.get(frame.path)?.()
            const stop = catalog.follow(
              frame.path,
              frame.fromByte,
              (entries, replaced, replaceFrom) => {
                const event: DaemonEvent = {
                  event: "entries",
                  path: frame.path,
                  entries,
                  replace: replaced,
                }
                if (replaceFrom !== undefined) event.replaceFrom = replaceFrom
                writeFrame(socket, serializeDaemonFrame(event))
              }
            )
            mine?.set(frame.path, stop)
            reply({ id: frame.id, ok: true, result: null })
            return
          }
          case "retire": {
            // A newer client wants this vintage gone. Answer, then leave —
            // the socket frees, and the successor takes over the watchers.
            reply({ id: frame.id, ok: true, result: null })
            retire()
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
            reply({ id: frame.id, ok: true, result: null })
            return
          }
        }
      } catch (error) {
        reply({
          id: frame.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
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

  let retiring = false
  const retire = () => {
    if (retiring) return
    retiring = true
    server.close()
    setTimeout(() => {
      catalog.stop()
      for (const client of clients) client.destroy()
    }, 100)
  }
  let highMemorySamples = 0
  const memoryTimer = setInterval(() => {
    highMemorySamples = daemonMemoryUnsafe(process.memoryUsage().rss)
      ? highMemorySamples + 1
      : 0
    if (highMemorySamples >= 3) retire()
  }, 5_000)

  server.once("close", () => {
    clearInterval(memoryTimer)
    eventLoopDelay.disable()
    stopEvents()
    void ownership.release()
    if (process.platform !== "win32") void unlink(socketPath).catch(() => {})
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    if (process.platform !== "win32") await chmod(socketPath, 0o600)
    return server
  } catch (error) {
    clearInterval(memoryTimer)
    eventLoopDelay.disable()
    stopEvents()
    await ownership.release()
    throw error
  }
}

/* ------------------------------------------------------------ client */

export interface DaemonClient {
  stats: DaemonStats
  refresh(): Promise<DaemonStats>
  list(filter?: { cwd?: string; harness?: string }): Promise<ThreadRef[]>
  open(path: string): Promise<Thread | null>
  page(path: string, before?: number, limit?: number): Promise<ThreadPage | null>
  follow(path: string, fromByte: number): Promise<void>
  unfollow(path?: string): Promise<void>
  /** Ask the daemon to exit — used to replace an older vintage. */
  retire(): Promise<void>
  onEvent(listener: (event: DaemonEvent) => void): () => void
  /** Fires once if the daemon goes away; the client is dead afterwards. */
  onClose(listener: () => void): void
  close(): void
}

/** One request, no session kept: proof of life and the stats that ride on it. */
export async function pingDaemon(
  socketPath = daemonSocketPath()
): Promise<DaemonStats> {
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
  const pending = new Map<number, PendingRequest>()
  const eventListeners = new Set<(event: DaemonEvent) => void>()
  const closeListeners = new Set<() => void>()
  let buffer = ""
  const decoder = new StringDecoder("utf8")

  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk)
    let at: number
    while ((at = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (Buffer.byteLength(raw) > MAX_RESPONSE_FRAME_BYTES) {
        socket.destroy(new Error("The sync daemon response was too large"))
        return
      }
      const record = parseJsonRecord(raw)
      if (!record) continue
      const id = readDaemonFrameId(record)
      if (id !== undefined) {
        const waiter = pending.get(id)
        if (!waiter) continue
        const response = parseDaemonResponse(record, waiter)
        if (!response) continue
        pending.delete(id)
        clearTimeout(waiter.timer)
        switch (response.kind) {
          case "ping":
            response.pending.resolve(response.result)
            break
          case "list":
            response.pending.resolve(response.result)
            break
          case "open":
            response.pending.resolve(response.result)
            break
          case "page":
            response.pending.resolve(response.result)
            break
          case "ack":
            response.pending.resolve()
            break
          case "error":
            response.pending.reject(response.error)
            break
        }
        continue
      }
      const event = parseDaemonEvent(record)
      if (event) {
        for (const listener of eventListeners) listener(event)
      }
    }
    if (Buffer.byteLength(buffer) > MAX_RESPONSE_FRAME_BYTES) {
      socket.destroy(new Error("The sync daemon response was too large"))
    }
  })

  const dead = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("The sync daemon went away"))
    }
    pending.clear()
    for (const listener of closeListeners) listener()
    closeListeners.clear()
  }
  socket.on("close", dead)
  socket.on("error", () => socket.destroy())

  const send = (frame: DaemonRequestFrame): void => {
    writeFrame(socket, serializeDaemonFrame(frame))
  }
  const requestTimer = (
    id: number,
    reject: (error: Error) => void,
    requestTimeout = timeoutMs
  ): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      if (!pending.delete(id)) return
      reject(new Error("The sync daemon request timed out"))
    }, requestTimeout)

  const requestPing = (): Promise<DaemonStats> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject)
      pending.set(id, { kind: "ping", resolve, reject, timer })
      send({ id, op: "ping" })
    })

  const requestList = (
    filter: { cwd?: string; harness?: string } = {}
  ): Promise<ThreadRef[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject)
      pending.set(id, { kind: "list", resolve, reject, timer })
      send({ id, op: "list", cwd: filter.cwd, harness: filter.harness })
    })

  const requestOpen = (path: string): Promise<Thread | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "open", resolve, reject, timer })
      send({ id, op: "open", path })
    })

  const requestPage = (
    path: string,
    before?: number,
    limit?: number
  ): Promise<ThreadPage | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "page", resolve, reject, timer })
      send({ id, op: "page", path, before, limit })
    })

  const requestAck = (
    frame: (id: number) => DaemonRequestFrame
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject)
      pending.set(id, { kind: "ack", resolve, reject, timer })
      send(frame(id))
    })

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The sync daemon did not answer")),
        timeoutMs
      )
      socket.once("connect", () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    const stats = await requestPing()

    return {
      stats,
      refresh: requestPing,
      list: requestList,
      open: requestOpen,
      page: requestPage,
      follow: (path, fromByte) =>
        requestAck((id) => ({ id, op: "follow", path, fromByte })),
      unfollow: (path) => requestAck((id) => ({ id, op: "unfollow", path })),
      retire: () => requestAck((id) => ({ id, op: "retire" })),
      onEvent: (listener) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      onClose: (listener) => void closeListeners.add(listener),
      close: () => socket.destroy(),
    }
  } catch (error) {
    socket.destroy()
    throw error
  }
}
