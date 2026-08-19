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

import { homedir } from "node:os"
import { join } from "node:path"
import { stat } from "node:fs/promises"
import { titleFrom, type Thread, type ThreadEntry, type ThreadRef } from "../format.js"
import type { NativeFile, SessionProvider } from "./types.js"

interface SqliteDatabase {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown }
  close(): void
}

let sqliteOpen: ((path: string) => SqliteDatabase) | null | undefined

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

/** Epoch seconds or millis — the store has carried both readings. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "number" || value <= 0) return undefined
  return new Date(value > 1e12 ? value : value * 1000).toISOString()
}

interface ChatMessage {
  role?: string
  content?: unknown
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

  async discover(): Promise<NativeFile[]> {
    const info = await stat(this.dbPath()).catch(() => null)
    if (!info) return []
    const db = await openDatabase(this.dbPath())
    if (!db) return []
    try {
      const rows = db
        .prepare(
          `SELECT s.id AS id, s.last_activity_at AS activity,
                  (SELECT COALESCE(MAX(row_id), 0) FROM message_nodes m WHERE m.session_id = s.id) AS top
           FROM sessions s WHERE s.hidden = 0`
        )
        .all() as Array<{ id?: string; activity?: number; top?: number }>
      return rows.flatMap((row) => {
        if (!row.id) return []
        const at = isoOf(row.activity)
        return [
          {
            path: `${this.dbPath()}#${row.id}`,
            bytes: row.top ?? 0,
            mtimeMs: at ? Date.parse(at) : info.mtimeMs,
          },
        ]
      })
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
      const row = db
        .prepare(
          "SELECT working_directory, model, title, created_at, last_activity_at FROM sessions WHERE id = ?"
        )
        .get(id) as
        | {
            working_directory?: string
            model?: string
            title?: string
            created_at?: number
            last_activity_at?: number
          }
        | undefined
      if (!row) return null
      return {
        harness: this.harness,
        nativeId: id,
        path: file.path,
        cwd: row.working_directory,
        title: row.title ? (titleFrom(row.title) ?? row.title) : undefined,
        model: row.model,
        modelProvider: "devin",
        startedAt: isoOf(row.created_at),
        updatedAt: isoOf(row.last_activity_at),
        bytes: file.bytes,
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
    const ref = await this.peek({ path, bytes: 0, mtimeMs: info.mtimeMs })
    if (!ref) return null
    const db = await openDatabase(this.dbPath())
    if (!db) return null
    try {
      const rows = db
        .prepare(
          "SELECT chat_message, created_at FROM message_nodes WHERE session_id = ? ORDER BY node_id"
        )
        .all(id) as Array<{ chat_message?: string; created_at?: number }>
      const entries: ThreadEntry[] = []
      for (const row of rows) {
        if (!row.chat_message) continue
        let message: ChatMessage
        try {
          message = JSON.parse(row.chat_message) as ChatMessage
        } catch {
          continue
        }
        const text = contentText(message.content)
        if (!text.trim()) continue
        const at = isoOf(row.created_at)
        if (message.role === "user") {
          entries.push({ kind: "user", at, text })
        } else if (message.role === "assistant") {
          entries.push({ kind: "assistant", at, blocks: [{ type: "text", text }] })
        }
        // System rows are rules preambles and tool scaffolding — provider
        // bookkeeping, not conversation.
      }
      ref.bytes = rows.length
      return { ref, entries }
    } catch {
      return null
    } finally {
      db.close()
    }
  }
}

function idOf(path: string): string | null {
  const at = path.lastIndexOf("#")
  return at === -1 ? null : path.slice(at + 1) || null
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: string })?.text === "string"
            ? (part as { text: string }).text
            : ""
      )
      .filter(Boolean)
      .join("\n")
  }
  return ""
}
