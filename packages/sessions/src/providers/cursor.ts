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

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"
import {
  clip,
  titleFrom,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import type { NativeFile, SessionProvider } from "./types.js"

interface SqliteDatabase {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }
  close(): void
}

let sqliteOpen: ((path: string) => SqliteDatabase) | null | undefined

/** `node:sqlite` loaded once, lazily; null when the runtime lacks it. */
async function openDatabase(path: string): Promise<SqliteDatabase | null> {
  if (sqliteOpen === undefined) {
    try {
      const sqlite = (await import("node:sqlite")) as {
        DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
      }
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

/** Epoch millis or an ISO string — Cursor's meta has carried both. */
function isoOf(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number") return new Date(value).toISOString()
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && asNumber > 1e12) return new Date(asNumber).toISOString()
  return value
}

/** The two protobuf reads the root blob needs: hash list and workspace URI. */
function parseRoot(data: Uint8Array): { hashes: string[]; cwd?: string } {
  const hashes: string[] = []
  let cwd: string | undefined
  let index = 0
  const varint = (): number => {
    let value = 0
    let shift = 0
    while (index < data.length) {
      const byte = data[index] as number
      index += 1
      value += (byte & 0x7f) * 2 ** shift
      shift += 7
      if ((byte & 0x80) === 0) break
    }
    return value
  }
  while (index < data.length) {
    const tag = varint()
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    if (wire === 0) {
      varint()
    } else if (wire === 2) {
      const length = varint()
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
      index += 4
    } else if (wire === 1) {
      index += 8
    } else {
      break // An unknown wire type means we are lost; stop rather than misread.
    }
  }
  return { hashes, cwd }
}

interface CursorMessage {
  role?: string
  content?: unknown
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/

/** What the user actually typed, or null for an injected scaffold message. */
function spokenText(content: unknown): string | null {
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
  private root: string

  constructor(home = homedir()) {
    this.root = join(home, ".cursor", "chats")
  }

  roots(): string[] {
    return [this.root]
  }

  async discover(): Promise<NativeFile[]> {
    const files: NativeFile[] = []
    let workspaces: string[]
    try {
      workspaces = await readdir(this.root)
    } catch {
      return []
    }
    await Promise.all(
      workspaces.map(async (workspace) => {
        let sessions: string[]
        try {
          sessions = await readdir(join(this.root, workspace))
        } catch {
          return
        }
        await Promise.all(
          sessions.map(async (session) => {
            const path = join(this.root, workspace, session, "store.db")
            try {
              const info = await stat(path)
              files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
            } catch {
              // A session directory without a store yet.
            }
          })
        )
      })
    )
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
      const named = meta.name && meta.name !== "New Agent" ? meta.name : undefined
      const ref: ThreadRef = {
        harness: this.harness,
        nativeId: meta.agentId ?? dirname(file.path).split("/").pop() ?? "",
        path: file.path,
        title: named,
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
        try {
          const parsed = JSON.parse(sidecar) as {
            cwd?: string
            createdAtMs?: number
            updatedAtMs?: number
          }
          if (parsed.cwd) ref.cwd = parsed.cwd
          if (parsed.updatedAtMs) ref.updatedAt = new Date(parsed.updatedAtMs).toISOString()
          if (parsed.createdAtMs) ref.startedAt = new Date(parsed.createdAtMs).toISOString()
        } catch {
          // Fall through to the root blob.
        }
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
      const toolsById = new Map<string, EntryBlock & { type: "tool" }>()

      for (const hash of root.hashes) {
        const message = this.readMessage(database, hash)
        if (!message) continue
        if (message.role === "user") {
          const spoken = spokenText(message.content)
          if (!spoken) continue
          assistant = null
          sink.push({ kind: "user", text: spoken })
          continue
        }
        if (message.role === "tool") {
          if (!Array.isArray(message.content)) continue
          for (const part of message.content) {
            const rec = part as Record<string, unknown>
            if (rec?.type !== "tool-result") continue
            const id = typeof rec.toolCallId === "string" ? rec.toolCallId : ""
            const block = toolsById.get(id)
            if (block) {
              block.output = clip(typeof rec.result === "string" ? rec.result : JSON.stringify(rec.result ?? ""))
              toolsById.delete(id)
            }
          }
          continue
        }
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue
        if (!assistant) {
          assistant = { kind: "assistant", blocks: [] }
          sink.push(assistant)
        }
        for (const part of message.content) {
          const rec = part as Record<string, unknown>
          switch (rec?.type) {
            case "text":
              if (typeof rec.text === "string" && rec.text) {
                assistant.blocks.push({ type: "text", text: rec.text })
              }
              break
            case "reasoning":
              if (typeof rec.text === "string" && rec.text) {
                assistant.blocks.push({ type: "thinking", text: rec.text })
              }
              break
            case "tool-call": {
              const block: EntryBlock & { type: "tool" } = {
                type: "tool",
                name: String(rec.toolName ?? "tool"),
                input: clip(rec.args === undefined ? undefined : JSON.stringify(rec.args)),
              }
              if (typeof rec.toolCallId === "string") toolsById.set(rec.toolCallId, block)
              assistant.blocks.push(block)
              break
            }
          }
        }
      }
      return { ref, entries: sink.done() }
    } finally {
      database.close()
    }
  }

  /* ------------------------------------------------------------ sqlite */

  private readMeta(
    database: SqliteDatabase
  ): { agentId?: string; name?: string; createdAt?: string | number; latestRootBlobId?: string } | null {
    try {
      const row = database.prepare("SELECT value FROM meta WHERE key = '0'").get() as
        | { value?: string | Uint8Array }
        | undefined
      if (!row?.value) return null
      const text =
        typeof row.value === "string"
          ? /^[0-9a-f]+$/i.test(row.value)
            ? Buffer.from(row.value, "hex").toString("utf8")
            : row.value
          : Buffer.from(row.value).toString("utf8")
      return JSON.parse(text) as ReturnType<CursorProvider["readMeta"]>
    } catch {
      return null
    }
  }

  /**
   * The newest epoch-millis found in the last few blobs — insertion order is
   * conversation order, so this is when the session truly last moved. A
   * varint scan yields false positives; bounds and max() filter them.
   */
  private readLastActivity(database: SqliteDatabase): string | undefined {
    try {
      const rows = database
        .prepare("SELECT data FROM blobs WHERE length(data) < 262144 ORDER BY rowid DESC LIMIT 30")
        .all() as Array<{ data?: Uint8Array }>
      const floor = Date.UTC(2015, 0, 1)
      const ceiling = Date.now() + 10 * 60_000
      let best = 0
      for (const row of rows) {
        const buffer = row.data
        if (!buffer) continue
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
            const byte = buffer[j]!
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

  private readRoot(
    database: SqliteDatabase,
    rootId: string | undefined
  ): { hashes: string[]; cwd?: string } | null {
    if (!rootId) return null
    try {
      const row = database.prepare("SELECT data FROM blobs WHERE id = ?").get(rootId) as
        | { data?: Uint8Array }
        | undefined
      return row?.data ? parseRoot(row.data) : null
    } catch {
      return null
    }
  }

  private readMessage(database: SqliteDatabase, hash: string): CursorMessage | null {
    try {
      const row = database.prepare("SELECT data FROM blobs WHERE id = ?").get(hash) as
        | { data?: Uint8Array }
        | undefined
      if (!row?.data) return null
      return JSON.parse(Buffer.from(row.data).toString("utf8")) as CursorMessage
    } catch {
      return null
    }
  }
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const rec = part as Record<string, unknown>
      return rec?.type === "text" && typeof rec.text === "string" ? rec.text : ""
    })
    .join("")
}
