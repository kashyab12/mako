/**
 * Cursor CLI sessions.
 *
 * Native store: `~/.cursor/chats/<workspace-hash>/<session-uuid>/store.db`,
 * an SQLite pair of tables: `blobs(id, data)` holds content-addressed
 * messages as JSON, and `meta` holds one JSON row naming the session and the
 * `latestRootBlobId`. The root blob is a protobuf whose repeated field 1 is
 * the ordered list of message hashes — that list *is* the transcript order —
 * with the workspace URI in field 9. A sibling `meta.json` (newer sessions)
 * carries cwd and timestamps without touching SQLite at all.
 *
 * Messages: `system` / `user` / `assistant` / `tool` roles; assistant
 * content is `text`, `reasoning` and `tool-call` parts; `tool` messages
 * carry the paired `tool-result`. Like Grok, Cursor wraps what the user
 * actually typed in a `<user_query>` tag inside a message that is mostly
 * injected context; user messages without the tag are scaffolding and are
 * skipped. Verified against 181 real session stores.
 *
 * SQLite comes from `node:sqlite` — present in the Node this app ships with;
 * where it is missing the provider reports no sessions rather than failing
 * the catalog.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite"
import {
  clip,
  EntrySink,
  titleFrom,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import type { NativeFile, SessionProvider } from "./types.js"

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue | undefined
}

interface CursorMeta {
  agentId?: string
  name?: string
  createdAt?: string | number
  latestRootBlobId?: string
  model?: string
}

interface CursorSidecar {
  cwd?: string
  title?: string
  createdAtMs?: number
  updatedAtMs?: number
  model?: string
}

interface CursorRoot {
  hashes: string[]
  cwd?: string
}

interface CursorTextPart {
  type: "text"
  text: string
}

interface CursorReasoningPart {
  type: "reasoning"
  text: string
}

interface CursorToolCallPart {
  type: "tool-call"
  toolName: string
  args?: JsonValue
  toolCallId?: string
}

interface CursorToolResultPart {
  type: "tool-result"
  toolCallId: string
  result?: JsonValue
}

interface CursorOtherPart {
  type: "other"
}

type CursorAssistantPart =
  | CursorTextPart
  | CursorReasoningPart
  | CursorToolCallPart
  | CursorOtherPart
type CursorToolPart = CursorToolResultPart | CursorOtherPart
type CursorTextContent = string | CursorTextPart[]

interface CursorUserMessage {
  role: "user"
  content: CursorTextContent
}

interface CursorAssistantMessage {
  role: "assistant"
  content: CursorAssistantPart[]
  model?: string
}

interface CursorToolMessage {
  role: "tool"
  content: CursorToolPart[]
  isError: boolean
}

interface CursorOtherMessage {
  role: "other"
}

type CursorMessage =
  | CursorUserMessage
  | CursorAssistantMessage
  | CursorToolMessage
  | CursorOtherMessage

type SqliteStatementResult = ReturnType<StatementSync["get"]>
type SqliteRows = ReturnType<StatementSync["all"]>
type ToolBlock = Extract<EntryBlock, { type: "tool" }>

interface MetaValueRow {
  value: string | NodeJS.NonSharedUint8Array
}

interface BlobDataRow {
  data: NodeJS.NonSharedUint8Array
}

let sqliteOpen: ((path: string) => DatabaseSync) | null | undefined

/** `node:sqlite` loaded once, lazily; null when the runtime lacks it. */
async function openDatabase(path: string): Promise<DatabaseSync | null> {
  if (sqliteOpen === undefined) {
    try {
      const sqlite = await import("node:sqlite")
      sqliteOpen = (file) => new sqlite.DatabaseSync(file, { readOnly: true })
    } catch {
      sqliteOpen = null
    }
  }
  if (!sqliteOpen) return null
  try {
    return sqliteOpen(path)
  } catch {
    return null
  }
}

function isStringValue(value: JsonValue | SQLOutputValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBytesValue(
  value: SQLOutputValue | undefined
): value is NodeJS.NonSharedUint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]"
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isStringValue(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

function parseJson(raw: string): JsonValue | undefined {
  try {
    const value: JsonValue = JSON.parse(raw)
    return value
  } catch {
    return undefined
  }
}

/** Epoch millis or an ISO string — Cursor's meta has carried both. */
function isoOf(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isNumberValue(value)) return new Date(value).toISOString()
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && asNumber > 1e12) return new Date(asNumber).toISOString()
  return value
}

/** The two protobuf reads the root blob needs: hash list and workspace URI. */
function parseRoot(data: Uint8Array): CursorRoot {
  const hashes: string[] = []
  let cwd: string | undefined
  let index = 0
  const varint = (): number | undefined => {
    let value = 0
    let shift = 0
    while (index < data.length && shift <= 49) {
      const byte = data[index]
      if (byte === undefined) return undefined
      index += 1
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
      shift += 7
    }
    return undefined
  }
  while (index < data.length) {
    const tag = varint()
    if (tag === undefined) break
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) {
      if (varint() === undefined) break
    } else if (wire === 2) {
      const length = varint()
      if (length === undefined || length > data.length - index) break
      const bytes = data.subarray(index, index + length)
      index += length
      if (field === 1 && length === 32) {
        hashes.push(Buffer.from(bytes).toString("hex"))
      }
      if (field === 9) {
        const uri = Buffer.from(bytes).toString("utf8")
        if (uri.startsWith("file://")) cwd = decodeURIComponent(uri.slice(7))
      }
    } else if (wire === 5) {
      if (data.length - index < 4) break
      index += 4
    } else if (wire === 1) {
      if (data.length - index < 8) break
      index += 8
    } else {
      break // An unknown wire type means we are lost; stop rather than misread.
    }
  }
  return { hashes, cwd }
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/

/** What the user actually typed, or null for an injected scaffold message. */
function spokenText(content: CursorTextContent): string | null {
  const text = plainText(content)
  const match = USER_QUERY.exec(text)
  if (match) return (match[1] ?? "").trim() || null
  // Older messages carry the bare prompt with no scaffolding at all.
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("[Previous conversation summary]")) {
    return null
  }
  return trimmed
}

export class CursorProvider implements SessionProvider {
  harness = "cursor" as const
  displayName = "Cursor"
  rescanRoot = true
  rescanDebounceMs = 250
  private chatRoot: string
  private acpRoot: string

  constructor(home = homedir()) {
    this.chatRoot = join(home, ".cursor", "chats")
    this.acpRoot = join(home, ".cursor", "acp-sessions")
  }

  roots(): string[] {
    return [this.chatRoot, this.acpRoot]
  }

  async discover(): Promise<NativeFile[]> {
    const files: NativeFile[] = []
    const workspaces = await readdir(this.chatRoot).catch((): string[] => [])
    for (const workspace of workspaces) {
      const root = join(this.chatRoot, workspace)
      const sessions = await readdir(root).catch((): string[] => [])
      for (const session of sessions) {
        const path = join(root, session, "store.db")
        // A session directory without a store yet.
        const info = await stat(path).catch(() => null)
        if (info) files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
      }
    }
    const acpSessions = await readdir(this.acpRoot).catch((): string[] => [])
    for (const session of acpSessions) {
      const path = join(this.acpRoot, session, "store.db")
      const info = await stat(path).catch(() => null)
      if (info) files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
    }
    return files
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const database = await openDatabase(file.path)
    if (!database) return null
    try {
      const meta = this.readMeta(database)
      if (!meta) return null
      // "New Agent" is the placeholder Cursor writes before a session is
      // named; the first real prompt makes a better title than that.
      const named =
        meta.name && meta.name !== "New Agent"
          ? titleFrom(meta.name)
          : undefined
      const ref: ThreadRef = {
        harness: this.harness,
        nativeId: meta.agentId ?? dirname(file.path).split("/").pop() ?? "",
        path: file.path,
        title: named,
        model: meta.model,
        startedAt: isoOf(meta.createdAt),
        // The store file's mtime lies: Cursor batch-touches old stores
        // (migrations, vacuums), which once made month-old sessions read as
        // "just now". meta.json's updatedAtMs is Cursor's own record of the
        // last turn; mtime is only the fallback when the sidecar is absent.
        updatedAt: new Date(file.mtimeMs).toISOString(),
        bytes: file.bytes,
      }
      // meta.json is the cheap source of cwd and honest activity times.
      const sidecar = await readFile(join(dirname(file.path), "meta.json"), "utf8").catch(() => null)
      if (sidecar) {
        const parsed = parseSidecar(sidecar)
        if (parsed?.cwd) ref.cwd = parsed.cwd
        if (!ref.title && parsed?.title) ref.title = titleFrom(parsed.title)
        if (parsed?.model) ref.model = parsed.model
        if (parsed?.updatedAtMs) ref.updatedAt = new Date(parsed.updatedAtMs).toISOString()
        if (parsed?.createdAtMs) ref.startedAt = new Date(parsed.createdAtMs).toISOString()
      } else {
        // Old-format stores have no sidecar. The last-inserted blobs carry
        // the real timestamps of the final turns; scan a few for the newest
        // plausible epoch instead of trusting a touched file.
        const activity = this.readLastActivity(database)
        if (activity) ref.updatedAt = activity
      }
      if (!ref.cwd || !ref.title) {
        const root = this.readRoot(database, meta.latestRootBlobId)
        if (root) {
          ref.cwd ??= root.cwd
          if (!ref.title) {
            for (const hash of root.hashes) {
              const message = this.readMessage(database, hash)
              if (message?.role === "user") {
                const spoken = spokenText(message.content)
                if (spoken) ref.title = titleFrom(spoken)
                if (ref.title) break
              }
            }
          }
        }
      }
      return ref.nativeId ? ref : null
    } finally {
      database.close()
    }
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const ref = await this.peek({ path, bytes: file.size, mtimeMs: file.mtimeMs })
    if (!ref) return null
    const database = await openDatabase(path)
    if (!database) return null
    try {
      const meta = this.readMeta(database)
      const root = meta ? this.readRoot(database, meta.latestRootBlobId) : null
      if (!root) return { ref, entries: [] }

      const sink = new EntrySink()
      type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
      let assistant: AssistantEntry | null = null
      const toolsById = new Map<string, ToolBlock>()

      for (const hash of root.hashes) {
        const message = this.readMessage(database, hash)
        if (!message) continue
        switch (message.role) {
          case "user": {
            const spoken = spokenText(message.content)
            if (!spoken) continue
            assistant = null
            sink.push({ kind: "user", text: spoken })
            continue
          }
          case "tool":
            for (const part of message.content) {
              if (part.type !== "tool-result") continue
              const block = toolsById.get(part.toolCallId)
              if (block) {
                block.output = clip(formatToolResult(part.result))
                if (message.isError) block.error = true
                toolsById.delete(part.toolCallId)
              }
            }
            continue
          case "assistant":
            if (!assistant) {
              assistant = { kind: "assistant", model: message.model, blocks: [] }
              sink.push(assistant)
            } else if (!assistant.model && message.model) {
              assistant.model = message.model
            }
            for (const part of message.content) {
              switch (part.type) {
                case "text":
                  if (part.text) assistant.blocks.push({ type: "text", text: part.text })
                  break
                case "reasoning":
                  if (part.text) assistant.blocks.push({ type: "thinking", text: part.text })
                  break
                case "tool-call": {
                  const block: ToolBlock = {
                    type: "tool",
                    name: part.toolName,
                    input: clip(formatJson(part.args)),
                  }
                  if (part.toolCallId) toolsById.set(part.toolCallId, block)
                  assistant.blocks.push(block)
                  break
                }
                case "other":
                  break
              }
            }
            continue
          case "other":
            continue
        }
      }
      return { ref, entries: sink.done() }
    } finally {
      database.close()
    }
  }

  /* ------------------------------------------------------------ sqlite */

  private readMeta(database: DatabaseSync): CursorMeta | null {
    try {
      const result = database.prepare("SELECT value FROM meta WHERE key = '0'").get()
      const row = parseMetaValueRow(result)
      if (!row) return null
      const text = isStringValue(row.value)
        ? /^[0-9a-f]+$/i.test(row.value)
          ? Buffer.from(row.value, "hex").toString("utf8")
          : row.value
        : Buffer.from(row.value).toString("utf8")
      return parseCursorMeta(text)
    } catch {
      return null
    }
  }

  /**
   * The newest epoch-millis found in the last few blobs — insertion order is
   * conversation order, so this is when the session truly last moved. A
   * varint scan yields false positives; bounds and max() filter them.
   */
  private readLastActivity(database: DatabaseSync): string | undefined {
    try {
      const rows: SqliteRows = database
        .prepare("SELECT data FROM blobs WHERE length(data) < 262144 ORDER BY rowid DESC LIMIT 30")
        .all()
      const floor = Date.UTC(2015, 0, 1)
      const ceiling = Date.now() + 10 * 60_000
      let best = 0
      for (const result of rows) {
        const row = parseBlobDataRow(result)
        if (!row) continue
        const buffer = row.data
        if (buffer[0] === 0x7b) {
          // A JSON blob (messages are JSON): epoch millis appear as plain
          // 13-digit numbers in the text.
          const text = Buffer.from(buffer).toString("utf8")
          for (const match of text.matchAll(/\b1[5-9]\d{11}\b/g)) {
            const value = Number(match[0])
            if (value > floor && value < ceiling && value > best) best = value
          }
          continue
        }
        for (let i = 0; i < buffer.length; i++) {
          let value = 0
          let shift = 0
          let j = i
          while (j < buffer.length && shift <= 49) {
            const byte = buffer[j]
            if (byte === undefined) break
            value += (byte & 0x7f) * 2 ** shift
            if ((byte & 0x80) === 0) break
            shift += 7
            j++
          }
          if (value > floor && value < ceiling && value > best) best = value
        }
      }
      return best > 0 ? new Date(best).toISOString() : undefined
    } catch {
      return undefined
    }
  }

  private readRoot(database: DatabaseSync, rootId: string | undefined): CursorRoot | null {
    if (!rootId) return null
    try {
      const result = database.prepare("SELECT data FROM blobs WHERE id = ?").get(rootId)
      const row = parseBlobDataRow(result)
      return row ? parseRoot(row.data) : null
    } catch {
      return null
    }
  }

  private readMessage(database: DatabaseSync, hash: string): CursorMessage | null {
    try {
      const result = database.prepare("SELECT data FROM blobs WHERE id = ?").get(hash)
      const row = parseBlobDataRow(result)
      return row ? parseCursorMessage(Buffer.from(row.data).toString("utf8")) : null
    } catch {
      return null
    }
  }
}

function parseMetaValueRow(result: SqliteStatementResult): MetaValueRow | null {
  if (!result) return null
  const value = result["value"]
  return isStringValue(value) || isBytesValue(value) ? { value } : null
}

function parseBlobDataRow(result: SqliteStatementResult): BlobDataRow | null {
  if (!result) return null
  const data = result["data"]
  return isBytesValue(data) ? { data } : null
}

function parseCursorMeta(raw: string): CursorMeta | null {
  const value = parseJson(raw)
  if (!isJsonObject(value)) return null
  const createdAt = stringValue(value["createdAt"]) ?? numberValue(value["createdAt"])
  return {
    agentId: stringValue(value["agentId"]),
    name: stringValue(value["name"]),
    createdAt,
    latestRootBlobId: stringValue(value["latestRootBlobId"]),
    model: stringValue(value["model"]),
  }
}

function parseSidecar(raw: string): CursorSidecar | null {
  const value = parseJson(raw)
  if (!isJsonObject(value)) return null
  return {
    cwd: stringValue(value["cwd"]),
    title: stringValue(value["title"]),
    createdAtMs: numberValue(value["createdAtMs"]),
    updatedAtMs: numberValue(value["updatedAtMs"]),
    model: stringValue(value["model"]),
  }
}

function parseCursorMessage(raw: string): CursorMessage | null {
  const value = parseJson(raw)
  if (!isJsonObject(value)) return null
  switch (stringValue(value["role"])) {
    case "user":
      return { role: "user", content: parseTextContent(value["content"]) }
    case "assistant":
      return {
        role: "assistant",
        content: parseAssistantContent(value["content"]),
        model: stringValue(value["model"]),
      }
    case "tool":
      return {
        role: "tool",
        content: parseToolContent(value["content"]),
        isError: cursorToolError(value["providerOptions"]),
      }
    default:
      return { role: "other" }
  }
}

function parseTextContent(value: JsonValue | undefined): CursorTextContent {
  if (isStringValue(value)) return value
  if (!Array.isArray(value)) return []
  const parts: CursorTextPart[] = []
  for (const candidate of value) {
    if (!isJsonObject(candidate) || stringValue(candidate["type"]) !== "text") continue
    const text = stringValue(candidate["text"])
    if (text !== undefined) parts.push({ type: "text", text })
  }
  return parts
}

function parseAssistantContent(value: JsonValue | undefined): CursorAssistantPart[] {
  if (!Array.isArray(value)) return []
  return value.map(parseAssistantPart)
}

function parseAssistantPart(value: JsonValue): CursorAssistantPart {
  if (!isJsonObject(value)) return { type: "other" }
  switch (stringValue(value["type"])) {
    case "text": {
      const text = stringValue(value["text"])
      return text === undefined ? { type: "other" } : { type: "text", text }
    }
    case "reasoning": {
      const text = stringValue(value["text"])
      return text === undefined ? { type: "other" } : { type: "reasoning", text }
    }
    case "tool-call":
      return {
        type: "tool-call",
        toolName: stringValue(value["toolName"]) ?? "tool",
        args: value["args"],
        toolCallId: stringValue(value["toolCallId"]),
      }
    default:
      return { type: "other" }
  }
}

function cursorToolError(value: JsonValue | undefined): boolean {
  const provider = isJsonObject(value) ? value : undefined
  const cursor = isJsonObject(provider?.["cursor"])
    ? provider["cursor"]
    : undefined
  const result = isJsonObject(cursor?.["highLevelToolCallResult"])
    ? cursor["highLevelToolCallResult"]
    : undefined
  return result?.["isError"] === true
}

function parseToolContent(value: JsonValue | undefined): CursorToolPart[] {
  if (!Array.isArray(value)) return []
  return value.map(parseToolPart)
}

function parseToolPart(value: JsonValue): CursorToolPart {
  if (!isJsonObject(value) || stringValue(value["type"]) !== "tool-result") {
    return { type: "other" }
  }
  return {
    type: "tool-result",
    toolCallId: stringValue(value["toolCallId"]) ?? "",
    result: value["result"],
  }
}

function formatJson(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value)
}

function formatToolResult(value: JsonValue | undefined): string {
  return isStringValue(value) ? value : (JSON.stringify(value ?? "") ?? "")
}

function plainText(content: CursorTextContent): string {
  return Array.isArray(content) ? content.map((part) => part.text).join("") : content
}
