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
import { unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionCatalog } from "./catalog.js"
import type { Thread, ThreadEntry, ThreadOrigin, ThreadRef } from "./format.js"

export function daemonSocketPath(): string {
  return join(homedir(), ".mako", "syncd.sock")
}

export interface DaemonStats {
  pid: number
  startedAt: number
  sessions: number
  version: number
}

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

type DaemonRequestFrame =
  | { id: number; op: "ping" }
  | { id: number; op: "list"; cwd?: string; harness?: string }
  | { id: number; op: "open"; path: string }
  | { id: number; op: "follow"; path: string; fromByte: number }
  | { id: number; op: "unfollow"; path?: string }
  | { id: number; op: "retire" }

type DaemonResponseFrame =
  | {
      id: number
      ok: true
      result: DaemonStats | ThreadRef[] | Thread | null
    }
  | { id: number; ok: false; error: string }

export type DaemonEvent =
  | { event: "added" | "updated"; ref: ThreadRef }
  | { event: "removed"; path: string }
  | {
      event: "entries"
      path: string
      entries: ThreadEntry[]
      replace: boolean
      replaceFrom?: number
    }

type DaemonServerFrame = DaemonResponseFrame | DaemonEvent

interface PendingBase {
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PingPending extends PendingBase {
  kind: "ping"
  resolve: (stats: DaemonStats) => void
}

interface ListPending extends PendingBase {
  kind: "list"
  resolve: (refs: ThreadRef[]) => void
}

interface OpenPending extends PendingBase {
  kind: "open"
  resolve: (thread: Thread | null) => void
}

interface AckPending extends PendingBase {
  kind: "ack"
  resolve: () => void
}

type PendingRequest = PingPending | ListPending | OpenPending | AckPending

type ParsedDaemonResponse =
  | { kind: "ping"; pending: PingPending; result: DaemonStats }
  | { kind: "list"; pending: ListPending; result: ThreadRef[] }
  | { kind: "open"; pending: OpenPending; result: Thread | null }
  | { kind: "ack"; pending: AckPending }
  | { kind: "error"; pending: PendingRequest; error: Error }

/**
 * Bumped when the wire *data* changes shape, not just the ops — a ref that
 * grew a field counts, because a stale daemon would keep serving refs
 * without it forever. Clients that see an older daemon retire it and let a
 * fresh one take the socket.
 */
export const PROTOCOL_VERSION = 11

/** Serve one catalog over the socket. Resolves once listening. */
export async function serveCatalog(
  catalog: SessionCatalog,
  socketPath = daemonSocketPath()
): Promise<Server> {
  // If a daemon already answers, this one has no job.
  const alive = await pingDaemon(socketPath).catch(() => null)
  if (alive)
    throw new Error(`A sync daemon is already running (pid ${alive.pid})`)
  await unlink(socketPath).catch(() => {}) // A stale socket from a dead process.

  const startedAt = Date.now()
  const clients = new Set<Socket>()
  const follows = new Map<Socket, Map<string, () => void>>()

  const broadcast = (frame: DaemonEvent) => {
    const line = serializeDaemonFrame(frame)
    for (const client of clients) client.write(line)
  }

  catalog.onEvent((event) => {
    if (event.type === "removed") {
      broadcast({ event: "removed", path: event.path })
      return
    }
    broadcast({ event: event.type, ref: event.ref })
  })

  const server = createServer((socket) => {
    clients.add(socket)
    follows.set(socket, new Map())
    let buffer = ""

    const reply = (frame: DaemonResponseFrame) => {
      socket.write(serializeDaemonFrame(frame))
    }

    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        const frame = parseDaemonRequest(raw)
        if (frame) void handle(frame)
      }
    })

    const handle = async (frame: DaemonRequestFrame) => {
      try {
        switch (frame.op) {
          case "ping":
            reply({
              id: frame.id,
              ok: true,
              result: {
                pid: process.pid,
                startedAt,
                sessions: catalog.list().length,
                version: PROTOCOL_VERSION,
              },
            })
            return
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
                socket.write(serializeDaemonFrame(event))
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
            setTimeout(() => process.exit(0), 100)
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

  socket.on("data", (chunk) => {
    buffer += chunk.toString()
    let at: number
    while ((at = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      const record = parseJsonRecord(raw)
      if (!record) continue
      const id = readNumber(record, "id")
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
    socket.write(`${JSON.stringify(frame)}\n`)
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

  const requestAck = (
    frame: (id: number) => DaemonRequestFrame
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject)
      pending.set(id, { kind: "ack", resolve, reject, timer })
      send(frame(id))
    })

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
    list: requestList,
    open: requestOpen,
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
}

function serializeDaemonFrame(frame: DaemonServerFrame): string {
  return `${JSON.stringify(frame)}\n`
}

function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    const value: JsonValue = JSON.parse(raw)
    return isJsonRecord(value) ? value : null
  } catch {
    return null
  }
}

function parseDaemonRequest(raw: string): DaemonRequestFrame | null {
  const record = parseJsonRecord(raw)
  if (!record) return null
  const id = readNumber(record, "id")
  const op = readString(record, "op")
  if (id === undefined || !Number.isInteger(id) || id < 0 || !op) return null
  switch (op) {
    case "ping":
      return { id, op }
    case "list":
      return {
        id,
        op,
        cwd: readString(record, "cwd"),
        harness: readString(record, "harness"),
      }
    case "open": {
      const path = readString(record, "path")
      return path ? { id, op, path } : null
    }
    case "follow": {
      const path = readString(record, "path")
      const fromByte = readNumber(record, "fromByte")
      return path && fromByte !== undefined && fromByte >= 0
        ? { id, op, path, fromByte }
        : null
    }
    case "unfollow":
      return { id, op, path: readString(record, "path") }
    case "retire":
      return { id, op }
    default:
      return null
  }
}

function parseDaemonResponse(
  record: JsonRecord,
  pending: PendingRequest
): ParsedDaemonResponse | null {
  const ok = readBoolean(record, "ok")
  if (ok === false) {
    return {
      kind: "error",
      pending,
      error: new Error(readString(record, "error") ?? "daemon error"),
    }
  }
  if (ok !== true) return null
  switch (pending.kind) {
    case "ping": {
      const result = parseDaemonStats(record.result)
      return result ? { kind: "ping", pending, result } : null
    }
    case "list": {
      const result = parseArray(record.result, parseThreadRef)
      return result ? { kind: "list", pending, result } : null
    }
    case "open": {
      if (record.result === null) return { kind: "open", pending, result: null }
      const result = parseThread(record.result)
      return result ? { kind: "open", pending, result } : null
    }
    case "ack":
      return record.result === null ? { kind: "ack", pending } : null
  }
}

function parseDaemonEvent(record: JsonRecord): DaemonEvent | null {
  const event = readString(record, "event")
  switch (event) {
    case "added":
    case "updated": {
      const ref = parseThreadRef(record.ref)
      return ref ? { event, ref } : null
    }
    case "removed": {
      const path = readString(record, "path")
      return path ? { event, path } : null
    }
    case "entries": {
      const path = readString(record, "path")
      const entries = parseArray(record.entries, parseThreadEntry)
      const replace = readBoolean(record, "replace")
      if (!path || !entries || replace === undefined) return null
      const frame: DaemonEvent = { event, path, entries, replace }
      const replaceFrom = readNumber(record, "replaceFrom")
      if (replaceFrom !== undefined) frame.replaceFrom = replaceFrom
      return frame
    }
    default:
      return null
  }
}

function parseDaemonStats(value: JsonValue | undefined): DaemonStats | null {
  if (!isJsonRecord(value)) return null
  const pid = readNumber(value, "pid")
  const startedAt = readNumber(value, "startedAt")
  const sessions = readNumber(value, "sessions")
  const version = readNumber(value, "version")
  return pid !== undefined &&
    startedAt !== undefined &&
    sessions !== undefined &&
    version !== undefined
    ? { pid, startedAt, sessions, version }
    : null
}

function parseThread(value: JsonValue | undefined): Thread | null {
  if (!isJsonRecord(value)) return null
  const ref = parseThreadRef(value.ref)
  const entries = parseArray(value.entries, parseThreadEntry)
  return ref && entries ? { ref, entries } : null
}

function parseThreadRef(value: JsonValue | undefined): ThreadRef | null {
  if (!isJsonRecord(value)) return null
  const harness = readString(value, "harness")
  const nativeId = readString(value, "nativeId")
  const path = readString(value, "path")
  if (!harness || !nativeId || !path) return null
  const ref: ThreadRef = { harness, nativeId, path }
  const cwd = readString(value, "cwd")
  const title = readString(value, "title")
  const model = readString(value, "model")
  const startedAt = readString(value, "startedAt")
  const updatedAt = readString(value, "updatedAt")
  const bytes = readNumber(value, "bytes")
  const locked = readBoolean(value, "locked")
  const lineage = parseArray(value.lineage, parseThreadOrigin)
  const modelProvider = readString(value, "modelProvider")
  const archived = readBoolean(value, "archived")
  if (cwd !== undefined) ref.cwd = cwd
  if (title !== undefined) ref.title = title
  if (model !== undefined) ref.model = model
  if (startedAt !== undefined) ref.startedAt = startedAt
  if (updatedAt !== undefined) ref.updatedAt = updatedAt
  if (bytes !== undefined) ref.bytes = bytes
  if (locked !== undefined) ref.locked = locked
  if (lineage) ref.lineage = lineage
  if (modelProvider !== undefined) ref.modelProvider = modelProvider
  if (archived !== undefined) ref.archived = archived
  return ref
}

function parseThreadOrigin(value: JsonValue): ThreadOrigin | null {
  if (!isJsonRecord(value)) return null
  const harness = readString(value, "harness")
  if (!harness) return null
  const origin: ThreadOrigin = { harness }
  const title = readString(value, "title")
  if (title !== undefined) origin.title = title
  return origin
}

function parseThreadEntry(value: JsonValue): ThreadEntry | null {
  if (!isJsonRecord(value)) return null
  const kind = readString(value, "kind")
  const at = readString(value, "at")
  if (kind === "user") {
    const text = readString(value, "text")
    if (text === undefined) return null
    const entry: ThreadEntry = { kind, text }
    if (at !== undefined) entry.at = at
    return entry
  }
  if (kind === "assistant") {
    const blocks = parseArray(value.blocks, parseEntryBlock)
    if (!blocks) return null
    const entry: ThreadEntry = { kind, blocks }
    const model = readString(value, "model")
    const usage = parseTurnUsage(value.usage)
    if (at !== undefined) entry.at = at
    if (model !== undefined) entry.model = model
    if (usage) entry.usage = usage
    return entry
  }
  if (kind === "event") {
    const label = readString(value, "label")
    if (label === undefined) return null
    const entry: ThreadEntry = { kind, label }
    const detail = readString(value, "detail")
    if (at !== undefined) entry.at = at
    if (detail !== undefined) entry.detail = detail
    return entry
  }
  return null
}

function parseEntryBlock(
  value: JsonValue
): Extract<ThreadEntry, { kind: "assistant" }>["blocks"][number] | null {
  if (!isJsonRecord(value)) return null
  const type = readString(value, "type")
  if (type === "text" || type === "thinking") {
    const text = readString(value, "text")
    return text === undefined ? null : { type, text }
  }
  if (type !== "tool") return null
  const name = readString(value, "name")
  if (name === undefined) return null
  const block: Extract<ThreadEntry, { kind: "assistant" }>["blocks"][number] = {
    type,
    name,
  }
  const input = readString(value, "input")
  const output = readString(value, "output")
  const error = readBoolean(value, "error")
  if (input !== undefined) block.input = input
  if (output !== undefined) block.output = output
  if (error !== undefined) block.error = error
  return block
}

function parseTurnUsage(
  value: JsonValue | undefined
): Extract<ThreadEntry, { kind: "assistant" }>["usage"] | null {
  if (!isJsonRecord(value)) return null
  const usage: NonNullable<
    Extract<ThreadEntry, { kind: "assistant" }>["usage"]
  > = {}
  const input = readNumber(value, "input")
  const output = readNumber(value, "output")
  const cacheRead = readNumber(value, "cacheRead")
  const cacheWrite = readNumber(value, "cacheWrite")
  const costUsd = readNumber(value, "costUsd")
  if (input !== undefined) usage.input = input
  if (output !== undefined) usage.output = output
  if (cacheRead !== undefined) usage.cacheRead = cacheRead
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite
  if (costUsd !== undefined) usage.costUsd = costUsd
  return usage
}

function parseArray<T>(
  value: JsonValue | undefined,
  parse: (item: JsonValue) => T | null
): T[] | null {
  if (!Array.isArray(value)) return null
  const parsed: T[] = []
  for (const item of value) {
    const result = parse(item)
    if (result === null) return null
    parsed.push(result)
  }
  return parsed
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isStringValue(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBooleanValue(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return isStringValue(value) ? value : undefined
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

function readBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key]
  return isBooleanValue(value) ? value : undefined
}
