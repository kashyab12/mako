import type { ThreadOrigin, ThreadRef } from "./format.js"

export interface CacheEntry {
  bytes: number
  mtimeMs: number
  ref: ThreadRef | null
}

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

export function parseCache(raw: string): Map<string, CacheEntry> | null {
  try {
    const value: JsonValue = JSON.parse(raw)
    if (!isJsonRecord(value) || readNumber(value, "version") !== 4) return null
    const stored = value.entries
    if (!isJsonRecord(stored)) return null
    const entries = new Map<string, CacheEntry>()
    for (const [path, candidate] of Object.entries(stored)) {
      const entry = parseCacheEntry(candidate)
      if (!entry) return null
      entries.set(path, entry)
    }
    return entries
  } catch {
    return null
  }
}

function parseCacheEntry(value: JsonValue | undefined): CacheEntry | null {
  if (!isJsonRecord(value)) return null
  const bytes = readNumber(value, "bytes")
  const mtimeMs = readNumber(value, "mtimeMs")
  if (bytes === undefined || mtimeMs === undefined) return null
  if (value.ref === null) return { bytes, mtimeMs, ref: null }
  const ref = parseCachedThreadRef(value.ref)
  return ref ? { bytes, mtimeMs, ref } : null
}

function parseCachedThreadRef(value: JsonValue | undefined): ThreadRef | null {
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
