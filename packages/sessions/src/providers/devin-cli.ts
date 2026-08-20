/**
 * devin-cli's own sessions — the ones Zed's agent panel (or any ACP host)
 * drives.
 *
 * The Devin IDE journals ACP traffic itself; the *CLI* keeps its own store:
 * one SQLite database at `~/.local/share/devin/cli/sessions.db` with a
 * `sessions` table (id, working_directory, model, title, activity) and a
 * `message_nodes` forest whose rows are JSON chat messages. A Devin thread
 * run through Zed exists only here — no per-session file anywhere.
 *
 * One database, many sessions, so discovery synthesizes one NativeFile per
 * session (`…/sessions.db#<id>`), sized by its highest message row and
 * dated by its last activity — the catalog's cheap change detection works
 * unchanged. The provider marks itself `rescanRoot`: a write to the db (or
 * its WAL) re-runs discovery instead of stat-ing a path that does not
 * exist as a file.
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import {
  clip,
  EntrySink,
  titleFrom,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./types.js"

type SqliteFields = Record<string, SQLOutputValue>
type StoredTimestamp = number | undefined
type ToolBlock = Extract<EntryBlock, { type: "tool" }>
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

type TextSource = JsonValue | SQLOutputValue | undefined

interface JsonObject {
  [key: string]: JsonValue
}

type ChatContent = JsonValue

interface ToolFunction {
  name?: string
  arguments?: JsonValue
}

interface ToolCall {
  id?: string
  name?: string
  arguments?: JsonValue
  function?: ToolFunction
}

interface ChatMessage {
  role?: string
  content?: ChatContent
  thinking?: ChatContent
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface DiscoveryRow {
  id: string
  activity: StoredTimestamp
  top: number
}

interface SessionRow {
  workingDirectory?: string
  model?: string
  title?: string
  createdAt: StoredTimestamp
  lastActivityAt: StoredTimestamp
}

interface MessageRow {
  rowId: number
  chatMessage?: string
  createdAt: StoredTimestamp
}

interface MessageTranslator {
  push(row: MessageRow): void
  snapshot(): ThreadEntry[]
  readonly unmatchedToolResult: boolean
}

let sqliteOpen: ((path: string) => DatabaseSync) | null | undefined

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

/** Epoch seconds or millis — the store has carried both readings. */
function isoOf(value: StoredTimestamp): string | undefined {
  if (value === undefined || value <= 0) return undefined
  return new Date(value > 1e12 ? value : value * 1000).toISOString()
}

export class DevinCliProvider implements SessionProvider {
  harness = "devin" as const
  displayName = "Devin"
  /** One store, many sessions: a db write means re-discover, not re-stat. */
  rescanRoot = true

  private dir: string

  constructor(home = homedir()) {
    this.dir = join(home, ".local", "share", "devin", "cli")
  }

  roots(): string[] {
    return [this.dir]
  }

  private dbPath(): string {
    return join(this.dir, "sessions.db")
  }

  private lockPath(): string {
    return join(this.dir, "session_locks")
  }

  async discover(): Promise<NativeFile[]> {
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return []
    const locked = await lockedSessionIds(this.lockPath())
    const db = await openDatabase(this.dbPath())
    if (!db) return []
    try {
      const stored = db
        .prepare(
          `SELECT s.id AS id, s.last_activity_at AS activity,
                  (SELECT COALESCE(MAX(row_id), 0) FROM message_nodes m WHERE m.session_id = s.id) AS top
           FROM sessions s WHERE s.hidden = 0`
        )
        .all()
      const files: NativeFile[] = []
      for (const fields of stored) {
        const row = parseDiscoveryRow(fields)
        if (!row) continue
        const at = isoOf(row.activity)
        const isLocked = locked.has(row.id)
        // Synthetic sessions share one database; this fractional revision lets
        // lock-only changes invalidate one cached ref without moving its cursor.
        files.push({
          path: `${this.dbPath()}#${row.id}`,
          bytes: row.top,
          mtimeMs: (at ? Date.parse(at) : info.mtimeMs) + (isLocked ? 0.5 : 0),
          locked: isLocked,
        })
      }
      return files
    } catch {
      return []
    } finally {
      db.close()
    }
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const id = idOf(file.path)
    if (!id) return null
    const db = await openDatabase(this.dbPath())
    if (!db) return null
    try {
      const stored = db
        .prepare(
          "SELECT working_directory, model, title, created_at, last_activity_at FROM sessions WHERE id = ?"
        )
        .get(id)
      if (!stored) return null
      const row = parseSessionRow(stored)
      return {
        harness: this.harness,
        nativeId: id,
        path: file.path,
        cwd: row.workingDirectory,
        title: row.title ? (titleFrom(row.title) ?? row.title) : undefined,
        model: row.model,
        modelProvider: "devin",
        startedAt: isoOf(row.createdAt),
        updatedAt: isoOf(row.lastActivityAt),
        bytes: file.bytes,
        locked: file.locked,
      }
    } catch {
      return null
    } finally {
      db.close()
    }
  }

  async read(path: string): Promise<Thread | null> {
    const id = idOf(path)
    if (!id) return null
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return null
    const locked = (await lockedSessionIds(this.lockPath())).has(id)
    const ref = await this.peek({
      path,
      bytes: 0,
      mtimeMs: info.mtimeMs,
      locked,
    })
    if (!ref) return null
    const db = await openDatabase(this.dbPath())
    if (!db) return null
    try {
      const stored = db
        .prepare(
          "SELECT row_id, chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY row_id"
        )
        .iterate(id)
      const into = translator()
      let cursor = 0
      for (const fields of stored) {
        const row = parseMessageRow(fields)
        cursor = Math.max(cursor, row.rowId)
        into.push(row)
      }
      ref.bytes = cursor
      return { ref, entries: into.snapshot() }
    } catch {
      return null
    } finally {
      db.close()
    }
  }

  createFollower(path: string, fromByte: number): SessionFollower {
    const id = idOf(path)
    let cursor = fromByte
    let into = translator()
    let previous: string[] = []

    return {
      get offset() {
        return cursor
      },
      next: async (): Promise<SessionUpdate> => {
        if (!id) return unchangedUpdate(cursor)
        const db = await openDatabase(this.dbPath())
        if (!db) return unchangedUpdate(cursor)
        try {
          const stored = db
            .prepare(
              "SELECT row_id, chat_message, created_at FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id"
            )
            .iterate(id, cursor)
          let changed = false
          for (const fields of stored) {
            const row = parseMessageRow(fields)
            cursor = Math.max(cursor, row.rowId)
            into.push(row)
            changed = true
          }
          if (!changed) return unchangedUpdate(cursor)
          if (into.unmatchedToolResult) {
            const full = await this.read(path)
            cursor = full?.ref.bytes ?? cursor
            into = translator()
            previous = []
            return {
              entries: full?.entries ?? [],
              nextByte: cursor,
              replace: true,
              replaceFrom: 0,
            }
          }
          const current = into.snapshot()
          let shared = 0
          while (
            shared < previous.length &&
            previous[shared] === JSON.stringify(current[shared])
          ) {
            shared += 1
          }
          const appended = shared === previous.length
          const entries = appended
            ? current.slice(previous.length)
            : current.slice(shared)
          previous = current.map((entry) => JSON.stringify(entry))
          const update: SessionUpdate = {
            entries: structuredClone(entries),
            nextByte: cursor,
            replace: !appended,
          }
          if (!appended) update.replaceFrom = shared
          return update
        } finally {
          db.close()
        }
      },
    }
  }
}

async function lockedSessionIds(path: string): Promise<Set<string>> {
  const files = await readdir(path).catch((): string[] => [])
  const locked = await Promise.all(
    files
      .filter((file) => file.endsWith(".lock"))
      .map(async (file) => {
        const raw = await readFile(join(path, file), "utf8").catch(() => "")
        const pid = Number(raw.trim())
        if (!Number.isInteger(pid) || pid <= 0) return null
        try {
          process.kill(pid, 0)
          return file.slice(0, -5)
        } catch {
          return null
        }
      })
  )
  return new Set(locked.filter((id): id is string => id !== null))
}

function translator(): MessageTranslator {
  const sink = new EntrySink()
  const tools = new Map<string, ToolBlock>()
  let unmatchedToolResult = false

  return {
    push(row) {
      if (!row.chatMessage) return
      const message = parseChatMessage(row.chatMessage)
      if (!message) return
      const at = isoOf(row.createdAt)
      if (message.role === "user") {
        const text = contentText(message.content)
        if (text.trim()) sink.push({ kind: "user", at, text })
        return
      }
      if (message.role === "assistant") {
        const blocks: EntryBlock[] = []
        const thinking = contentText(message.thinking)
        if (thinking.trim()) blocks.push({ type: "thinking", text: thinking })
        for (const call of message.tool_calls ?? []) {
          const name = call.name ?? call.function?.name ?? "tool"
          const rawInput = call.arguments ?? call.function?.arguments
          const block: ToolBlock = {
            type: "tool",
            name,
            input: toolInputText(rawInput),
          }
          blocks.push(block)
          if (call.id) tools.set(call.id, block)
        }
        const text = contentText(message.content)
        if (text.trim()) blocks.push({ type: "text", text })
        if (blocks.length > 0) sink.push({ kind: "assistant", at, blocks })
        return
      }
      if (message.role === "tool") {
        const block = message.tool_call_id
          ? tools.get(message.tool_call_id)
          : undefined
        if (!block) {
          unmatchedToolResult = true
          return
        }
        const output = contentText(message.content)
        if (output) block.output = clip(output)
      }
    },
    snapshot() {
      return sink.snapshot()
    },
    get unmatchedToolResult() {
      return unmatchedToolResult
    },
  }
}

function unchangedUpdate(nextByte: number): SessionUpdate {
  return { entries: [], nextByte, replace: false }
}

function parseDiscoveryRow(fields: SqliteFields): DiscoveryRow | null {
  if (!isTextValue(fields.id) || !fields.id) return null
  return {
    id: fields.id,
    activity: sqliteNumber(fields.activity),
    top: isSqliteNumber(fields.top) ? fields.top : 0,
  }
}

function parseSessionRow(fields: SqliteFields): SessionRow {
  return {
    workingDirectory: sqliteText(fields.working_directory),
    model: sqliteText(fields.model),
    title: sqliteText(fields.title),
    createdAt: sqliteNumber(fields.created_at),
    lastActivityAt: sqliteNumber(fields.last_activity_at),
  }
}

function parseMessageRow(fields: SqliteFields): MessageRow {
  return {
    rowId: isSqliteNumber(fields.row_id) ? fields.row_id : 0,
    chatMessage: sqliteText(fields.chat_message),
    createdAt: sqliteNumber(fields.created_at),
  }
}

function parseChatMessage(text: string): ChatMessage | null {
  try {
    const parsed: JsonValue = JSON.parse(text)
    if (!isJsonObject(parsed)) return null
    return {
      role: jsonText(parsed.role),
      content: parsed.content,
      thinking: parsed.thinking,
      tool_calls: parseToolCalls(parsed.tool_calls),
      tool_call_id: jsonText(parsed.tool_call_id),
    }
  } catch {
    return null
  }
}

function parseToolCalls(value: JsonValue | undefined): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined
  const calls: ToolCall[] = []
  for (const item of value) {
    if (!isJsonObject(item)) continue
    calls.push({
      id: jsonText(item.id),
      name: jsonText(item.name),
      arguments: item.arguments,
      function: parseToolFunction(item.function),
    })
  }
  return calls
}

function parseToolFunction(
  value: JsonValue | undefined
): ToolFunction | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    name: jsonText(value.name),
    arguments: value.arguments,
  }
}

function sqliteText(value: SQLOutputValue | undefined): string | undefined {
  return isTextValue(value) ? value : undefined
}

function jsonText(value: JsonValue | undefined): string | undefined {
  return isTextValue(value) ? value : undefined
}

function sqliteNumber(value: SQLOutputValue | undefined): StoredTimestamp {
  return isSqliteNumber(value) ? value : undefined
}

function isTextValue(value: TextSource): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isSqliteNumber(value: SQLOutputValue | undefined): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(Number(value))
  )
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null &&
    value !== undefined &&
    Object(value) === value &&
    !Array.isArray(value)
  )
}

function toolInputText(input: JsonValue | undefined): string | undefined {
  if (input === undefined) return undefined
  return clip(isTextValue(input) ? input : JSON.stringify(input))
}

function idOf(path: string): string | null {
  const at = path.lastIndexOf("#")
  return at === -1 ? null : path.slice(at + 1) || null
}

function contentText(content: ChatContent | undefined): string {
  if (isTextValue(content)) return content
  if (isJsonObject(content)) {
    if (isTextValue(content.text)) return content.text
    if (isTextValue(content.thinking)) return content.thinking
    if (content.content !== undefined) return contentText(content.content)
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isTextValue(part)) return part
        return isJsonObject(part) && isTextValue(part.text) ? part.text : ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return ""
}
