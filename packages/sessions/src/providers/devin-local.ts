/**
 * Devin, running locally.
 *
 * Devin's desktop app is a VS Code lineage editor driving `devin-cli` over
 * ACP, and it journals every session as append-only NDJSON — one file per
 * session under `~/Library/Application Support/Devin/User/acp-events/`,
 * each line an ACP `session/update` notification with a timestamp in
 * `_meta`. Titles, working directories, and the model in force live in the
 * editor's global `state.vscdb` (`windsurf.acp.metadataCache`, with
 * `windsurf.acp.eventLog.index` mapping session ids to journal uuids).
 *
 * Append-only NDJSON means these sessions tail like Pi's: a Devin turn
 * streams into the catalog live, byte offset by byte offset.
 *
 * SQLite comes from `node:sqlite`, loaded lazily like the Cursor provider
 * does; a runtime without it (or a machine without Devin) contributes
 * nothing rather than failing.
 */

import { homedir } from "node:os"
import { join, basename } from "node:path"
import { readdir, stat } from "node:fs/promises"
import { clip, EntrySink, titleFrom, type Thread, type ThreadEntry, type ThreadRef } from "../format.js"
import { createJsonlFollower, readLines, snapshotSink } from "../jsonl.js"
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

interface SessionMeta {
  sessionId: string
  title?: string
  cwd?: string
  model?: string
  createdAt?: string
  updatedAt?: string
}

interface EventLine {
  notification?: {
    sessionUpdate?: string
    content?: { text?: string }
    title?: string
    rawInput?: unknown
    toolCallId?: string
    status?: string
    _meta?: Record<string, unknown>
  }
}

export class DevinLocalProvider implements SessionProvider {
  harness = "devin" as const
  displayName = "Devin"

  private userDir: string
  /** uuid (journal basename) → session metadata, refreshed by db mtime. */
  private metaByUuid = new Map<string, SessionMeta>()
  private metaLoadedAtMs = 0

  constructor(userDir = join(homedir(), "Library", "Application Support", "Devin", "User")) {
    this.userDir = userDir
  }

  roots(): string[] {
    return [join(this.userDir, "acp-events")]
  }

  async discover(): Promise<NativeFile[]> {
    const root = this.roots()[0]!
    const names = await readdir(root).catch(() => [] as string[])
    const files: NativeFile[] = []
    for (const name of names) {
      if (!name.endsWith(".ndjson")) continue
      const path = join(root, name)
      const info = await stat(path).catch(() => null)
      if (info?.isFile()) files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
    }
    return files
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const meta = await this.metaFor(basename(file.path, ".ndjson"))
    // The IDE names sessions "acp/devin-cli/<name>"; the CLI's own store
    // says just "<name>". One session, one identity — normalized here so
    // the catalog's dedupe collapses the two views of the same thread.
    const rawId = meta?.sessionId ?? basename(file.path, ".ndjson")
    const ref: ThreadRef = {
      harness: this.harness,
      nativeId: rawId.split("/").pop() ?? rawId,
      path: file.path,
      cwd: meta?.cwd,
      title: meta?.title ? (titleFrom(meta.title) ?? meta.title) : undefined,
      model: meta?.model,
      modelProvider: "devin",
      startedAt: meta?.createdAt,
      updatedAt: meta?.updatedAt ?? new Date(file.mtimeMs).toISOString(),
      bytes: file.bytes,
    }
    if (!ref.title || !ref.startedAt) {
      // No metadata (or a stale cache): the journal's own first lines carry
      // a title update and the first user words. Bounded read.
      const skim = translator()
      let budget = 64_000
      await readLines(file.path, 0, (line) => {
        budget -= line.length + 1
        skim.push(line)
        return budget > 0
      })
      const first = skim.done().find((entry) => entry.kind === "user")
      if (!ref.title && skim.title) ref.title = titleFrom(skim.title) ?? skim.title
      if (!ref.title && first?.kind === "user") ref.title = titleFrom(first.text)
      if (!ref.startedAt && first?.at) ref.startedAt = first.at
    }
    return ref
  }

  async read(path: string): Promise<Thread | null> {
    const info = await stat(path).catch(() => null)
    if (!info) return null
    const ref = await this.peek({ path, bytes: info.size, mtimeMs: info.mtimeMs })
    if (!ref) return null
    const into = translator()
    await readLines(path, 0, into.push)
    const entries = into.done()
    if (!ref.title && into.title) ref.title = titleFrom(into.title) ?? into.title
    return { ref, entries }
  }

  createFollower(path: string, fromByte: number) {
    return createJsonlFollower(path, fromByte, translator)
  }

  async tail(path: string, fromByte: number): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = translator()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }

  /* ---------------------------------------------------------- metadata */

  private async metaFor(uuid: string): Promise<SessionMeta | null> {
    await this.refreshMeta()
    return this.metaByUuid.get(uuid) ?? null
  }

  private async refreshMeta(): Promise<void> {
    const dbPath = join(this.userDir, "globalStorage", "state.vscdb")
    const info = await stat(dbPath).catch(() => null)
    if (!info || info.mtimeMs === this.metaLoadedAtMs) return
    const db = await openDatabase(dbPath)
    if (!db) return
    try {
      const row = (sql: string) =>
        (db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(sql) as
          | { value?: string }
          | undefined)?.value
      const indexRaw = row("windsurf.acp.eventLog.index")
      const metaRaw = row("windsurf.acp.metadataCache")
      if (!indexRaw || !metaRaw) return
      const index = JSON.parse(indexRaw) as Record<
        string,
        { uuid?: string; lastUpdated?: number }
      >
      const cache = JSON.parse(metaRaw) as {
        sessions?: Array<{
          sessionId?: string
          title?: string
          cwd?: string
          _meta?: Record<string, unknown>
          configOptions?: Array<{ id?: string; currentValue?: unknown }>
        }>
      }
      const bySession = new Map<string, SessionMeta>()
      for (const session of cache.sessions ?? []) {
        if (!session.sessionId) continue
        const model = session.configOptions?.find((option) => option.id === "model")
        bySession.set(session.sessionId, {
          sessionId: session.sessionId,
          title: session.title,
          cwd: session.cwd,
          model: typeof model?.currentValue === "string" ? model.currentValue : undefined,
          createdAt:
            typeof session._meta?.["cognition.ai/createdAt"] === "string"
              ? (session._meta["cognition.ai/createdAt"] as string)
              : undefined,
        })
      }
      this.metaByUuid.clear()
      for (const [sessionId, entry] of Object.entries(index)) {
        if (!entry.uuid) continue
        const meta = bySession.get(sessionId) ?? { sessionId }
        if (entry.lastUpdated) meta.updatedAt = new Date(entry.lastUpdated).toISOString()
        this.metaByUuid.set(entry.uuid, meta)
      }
      this.metaLoadedAtMs = info.mtimeMs
    } catch {
      // A malformed cache reads as no metadata; peeks fall back to the journal.
    } finally {
      db.close()
    }
  }
}

/* -------------------------------------------------------------- events */

/**
 * ACP notifications → canonical entries. Chunk streams coalesce: a run of
 * `agent_message_chunk`s is one text block, a thought run one thinking
 * block, and tool calls pick up their updates by id. User chunks group by
 * the client message id so a multi-chunk prompt stays one entry.
 */
function translator(): {
  push: (raw: string) => void
  snapshot: () => ThreadEntry[]
  done: () => ThreadEntry[]
  title?: string
} {
  type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
  const sink = new EntrySink()
  const state: { title?: string } = {}
  let assistant: AssistantEntry | null = null
  let userId: string | null = null
  const toolsById = new Map<string, { type: "tool"; name: string; input?: string; output?: string; error?: boolean }>()

  const flushAssistant = () => {
    if (assistant) sink.push(assistant)
    assistant = null
    toolsById.clear()
  }

  const ensureAssistant = (at?: string): AssistantEntry => {
    if (!assistant) assistant = { kind: "assistant", at, blocks: [] }
    return assistant
  }

  const appendText = (kind: "text" | "thinking", text: string, at?: string) => {
    const entry = ensureAssistant(at)
    const last = entry.blocks.at(-1)
    if (last && last.type === kind) {
      last.text += text
    } else {
      entry.blocks.push({ type: kind, text })
    }
  }

  const push = (raw: string): void => {
    let line: EventLine
    try {
      line = JSON.parse(raw) as EventLine
    } catch {
      return
    }
    const event = line.notification
    if (!event?.sessionUpdate) return
    const meta = event._meta ?? {}
    const at =
      typeof meta["cognition.ai/timestamp"] === "string"
        ? (meta["cognition.ai/timestamp"] as string)
        : undefined

    switch (event.sessionUpdate) {
      case "user_message_chunk": {
        const text = event.content?.text ?? ""
        if (!text) return
        const id =
          typeof meta["cognition.ai/clientMessageId"] === "string"
            ? (meta["cognition.ai/clientMessageId"] as string)
            : null
        const lastEntry = sink.entries.at(-1)
        if (id && id === userId && lastEntry?.kind === "user") {
          lastEntry.text += text
          return
        }
        flushAssistant()
        userId = id
        sink.push({ kind: "user", at, text })
        return
      }
      case "agent_message_chunk":
        appendText("text", event.content?.text ?? "", at)
        return
      case "agent_thought_chunk":
        appendText("thinking", event.content?.text ?? "", at)
        return
      case "tool_call": {
        const entry = ensureAssistant(at)
        const name =
          (typeof meta["cognition.ai/inferenceToolName"] === "string"
            ? (meta["cognition.ai/inferenceToolName"] as string)
            : undefined) ??
          (event as { title?: string }).title ??
          "tool"
        const block: { type: "tool"; name: string; input?: string; output?: string; error?: boolean } = {
          type: "tool",
          name,
          input:
            event.rawInput === undefined
              ? undefined
              : typeof event.rawInput === "string"
                ? event.rawInput
                : JSON.stringify(event.rawInput),
        }
        entry.blocks.push(block)
        if (event.toolCallId) toolsById.set(event.toolCallId, block)
        return
      }
      case "tool_call_update": {
        const block = event.toolCallId ? toolsById.get(event.toolCallId) : undefined
        if (block) {
          const output = event.content?.text
          if (output) block.output = clip(`${block.output ?? ""}${output}`)
          if (event.status === "failed") block.error = true
        }
        return
      }
      case "session_info_update":
        if (event.title) state.title = event.title
        return
      case "current_mode_update":
        flushAssistant()
        return
      default:
        return
    }
  }

  return {
    push,
    snapshot: () => {
      const entries = snapshotSink(sink)
      return assistant ? [...entries, assistant] : entries
    },
    done: () => {
      flushAssistant()
      return snapshotSink(sink)
    },
    get title() {
      return state.title
    },
  }
}
