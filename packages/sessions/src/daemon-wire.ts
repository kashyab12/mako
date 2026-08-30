import type {
  Thread,
  ThreadEntry,
  ThreadOrigin,
  ThreadPage,
  ThreadRef,
} from "./format.js"

export interface DaemonStats {
  pid: number
  startedAt: number
  sessions: number
  version: number
  rss?: number
  heapUsed?: number
  eventLoopP99Ms?: number
}

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

export interface JsonRecord {
  [key: string]: JsonValue | undefined
}

export type DaemonRequestFrame =
  | { id: number; op: "ping" }
  | { id: number; op: "list"; cwd?: string; harness?: string }
  | { id: number; op: "open"; path: string }
  | { id: number; op: "page"; path: string; before?: number; limit?: number }
  | { id: number; op: "follow"; path: string; fromByte: number }
  | { id: number; op: "unfollow"; path?: string }
  | { id: number; op: "retire" }

export type DaemonResponseFrame =
  | {
      id: number
      ok: true
      result: DaemonStats | ThreadRef[] | Thread | ThreadPage | null
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

interface PagePending extends PendingBase {
  kind: "page"
  resolve: (page: ThreadPage | null) => void
}

interface AckPending extends PendingBase {
  kind: "ack"
  resolve: () => void
}

export type PendingRequest =
  | PingPending
  | ListPending
  | OpenPending
  | PagePending
  | AckPending

export type ParsedDaemonResponse =
  | { kind: "ping"; pending: PingPending; result: DaemonStats }
  | { kind: "list"; pending: ListPending; result: ThreadRef[] }
  | { kind: "open"; pending: OpenPending; result: Thread | null }
  | { kind: "page"; pending: PagePending; result: ThreadPage | null }
  | { kind: "ack"; pending: AckPending }
  | { kind: "error"; pending: PendingRequest; error: Error }

export function serializeDaemonFrame(
  frame: DaemonRequestFrame | DaemonServerFrame
): string {
  return `${JSON.stringify(frame)}\n`
}

export function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    const value: JsonValue = JSON.parse(raw)
    return isJsonRecord(value) ? value : null
  } catch {
    return null
  }
}

export function readDaemonFrameId(record: JsonRecord): number | undefined {
  return readNumber(record, "id")
}

export function parseDaemonRequest(raw: string): DaemonRequestFrame | null {
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
    case "page": {
      const path = readString(record, "path")
      const before = readNumber(record, "before")
      const limit = readNumber(record, "limit")
      return path ? { id, op, path, before, limit } : null
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

export function parseDaemonResponse(
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
    case "page": {
      if (record.result === null) return { kind: "page", pending, result: null }
      const result = parseThreadPage(record.result)
      return result ? { kind: "page", pending, result } : null
    }
    case "ack":
      return record.result === null ? { kind: "ack", pending } : null
  }
}

export function parseDaemonEvent(record: JsonRecord): DaemonEvent | null {
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
  if (
    pid === undefined ||
    startedAt === undefined ||
    sessions === undefined ||
    version === undefined
  )
    return null
  const result: DaemonStats = { pid, startedAt, sessions, version }
  const rss = readNumber(value, "rss")
  const heapUsed = readNumber(value, "heapUsed")
  const eventLoopP99Ms = readNumber(value, "eventLoopP99Ms")
  if (rss !== undefined) result.rss = rss
  if (heapUsed !== undefined) result.heapUsed = heapUsed
  if (eventLoopP99Ms !== undefined) result.eventLoopP99Ms = eventLoopP99Ms
  return result
}

function parseThread(value: JsonValue | undefined): Thread | null {
  if (!isJsonRecord(value)) return null
  const ref = parseThreadRef(value.ref)
  const entries = parseArray(value.entries, parseThreadEntry)
  return ref && entries ? { ref, entries } : null
}

function parseThreadPage(value: JsonValue | undefined): ThreadPage | null {
  if (!isJsonRecord(value)) return null
  const ref = parseThreadRef(value.ref)
  const entries = parseArray(value.entries, parseThreadEntry)
  const start = readNumber(value, "start")
  const total = readNumber(value, "total")
  const hasEarlier = readBoolean(value, "hasEarlier")
  return ref &&
    entries &&
    start !== undefined &&
    total !== undefined &&
    hasEarlier !== undefined
    ? { ref, entries, start, total, hasEarlier }
    : null
}

function parseThreadRef(value: JsonValue | undefined): ThreadRef | null {
  if (!isJsonRecord(value)) return null
  const harness = readString(value, "harness")
  const nativeId = readString(value, "nativeId")
  const path = readString(value, "path")
  if (!harness || !nativeId || !path) return null
  const ref: ThreadRef = { harness, nativeId, path }
  const cwd = readString(value, "cwd")
  const workspace = readString(value, "workspace")
  const title = readString(value, "title")
  const model = readString(value, "model")
  const startedAt = readString(value, "startedAt")
  const updatedAt = readString(value, "updatedAt")
  const bytes = readNumber(value, "bytes")
  const locked = readBoolean(value, "locked")
  const active = readBoolean(value, "active")
  const lineage = parseArray(value.lineage, parseThreadOrigin)
  const modelProvider = readString(value, "modelProvider")
  const archived = readBoolean(value, "archived")
  if (cwd !== undefined) ref.cwd = cwd
  if (workspace !== undefined) ref.workspace = workspace
  if (title !== undefined) ref.title = title
  if (model !== undefined) ref.model = model
  if (startedAt !== undefined) ref.startedAt = startedAt
  if (updatedAt !== undefined) ref.updatedAt = updatedAt
  if (bytes !== undefined) ref.bytes = bytes
  if (locked !== undefined) ref.locked = locked
  if (active !== undefined) ref.active = active
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
