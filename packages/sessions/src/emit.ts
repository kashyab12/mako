/**
 * Native session emitters — the deepest form of continuation.
 *
 * A handoff prompt tells the next agent about a conversation; an emitted
 * session *is* the conversation, written in the target harness's own store
 * format so its ordinary resume machinery loads it with the full history in
 * context. Resume a session emitted this way and the agent does not read a
 * summary of what happened — it remembers it, because as far as its harness
 * is concerned, it happened to it. Verified: a synthesized Claude Code
 * session file resumes with full recall of facts that exist nowhere else.
 *
 * Tool activity is rendered as formatted text inside assistant messages
 * rather than as structured tool-use records. Deliberate: every harness
 * validates its own tool shapes on replay (paired ids, parseable inputs,
 * known names), and a foreign session cannot satisfy Claude's rules with
 * Codex's tools. Text carries the same information and replays anywhere.
 *
 * Verified through each owning reader, with live resume checks for Claude
 * Code and Codex confirming that emitted history returns in model context.
 */

import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Thread, ThreadEntry } from "./format.js"

export interface EmitResult {
  sessionId: string
  path: string
}

export interface EmitOptions {
  cwd?: string
  home?: string
}

interface Message {
  role: "user" | "assistant"
  text: string
  at?: string
}

interface PersistedClaudeContent {
  type: "text"
  text: string
}

interface PersistedClaudeMessage {
  role: Message["role"]
  model?: "imported"
  content: PersistedClaudeContent[]
}

interface PersistedClaudeEntry {
  type: Message["role"]
  uuid: string
  parentUuid: string | null
  sessionId: string
  timestamp: string
  cwd: string
  isSidechain: false
  userType?: "external"
  message: PersistedClaudeMessage
}

/**
 * Flatten canonical entries into alternating user/assistant text messages —
 * the intersection every harness's store can hold and replay.
 */
function flatten(entries: ThreadEntry[]): Message[] {
  const messages: Message[] = []
  for (const entry of entries) {
    if (entry.kind === "user") {
      messages.push({ role: "user", text: entry.text, at: entry.at })
      continue
    }
    if (entry.kind === "event") {
      const last = messages[messages.length - 1]
      const note = `*[${entry.label}${entry.detail ? `: ${entry.detail}` : ""}]*`
      if (last?.role === "assistant") last.text += `\n\n${note}`
      continue
    }
    const parts: string[] = []
    for (const block of entry.blocks) {
      if (block.type === "text" && block.text.trim()) parts.push(block.text.trim())
      if (block.type === "tool") {
        const lines = [`[tool: ${block.name}${block.error ? " — failed" : ""}]`]
        if (block.input) lines.push(`input: ${clip(block.input, 600)}`)
        if (block.output?.trim()) lines.push(`output:\n${clip(block.output.trim(), 2000)}`)
        parts.push(lines.join("\n"))
      }
      // Thinking is the original model's private state; it does not replay.
    }
    if (parts.length === 0) continue
    const text = parts.join("\n\n")
    const last = messages[messages.length - 1]
    if (last?.role === "assistant") last.text += `\n\n${text}`
    else messages.push({ role: "assistant", text, at: entry.at })
  }
  // Every store expects the conversation to open with a user message.
  while (messages.length > 0 && messages[0]?.role !== "user") messages.shift()
  if (messages.length === 0) {
    throw new Error("This conversation has no replayable turns")
  }
  return messages
}

/**
 * Write a thread into Claude Code's own store, resumable by session id with
 * `claude --resume` or loaded live over ACP.
 */
export async function emitClaudeSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const sessionId = randomUUID()
  const slug = cwd.replace(/[^a-zA-Z0-9-]/g, "-")
  const dir = join(home, ".claude", "projects", slug)
  await mkdir(dir, { recursive: true })

  const lines: string[] = []
  let parentUuid: string | null = null
  for (const message of flatten(thread.entries)) {
    const uuid = randomUUID()
    const entry: PersistedClaudeEntry = {
      type: message.role,
      uuid,
      parentUuid,
      sessionId,
      timestamp: message.at ?? new Date().toISOString(),
      cwd,
      isSidechain: false,
      userType: message.role === "user" ? "external" : undefined,
      message: {
        role: message.role,
        model: message.role === "assistant" ? "imported" : undefined,
        content: [{ type: "text", text: message.text }],
      },
    }
    lines.push(JSON.stringify(entry))
    parentUuid = uuid
  }

  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, `${lines.join("\n")}\n`, "utf8")
  return { sessionId, path }
}

/**
 * Write a thread into Codex's rollout store, resumable with
 * `codex exec resume <id>` — which replays the message items into context.
 */
export async function emitCodexSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const sessionId = randomUUID()
  const now = new Date()
  const iso = now.toISOString()
  const dir = join(
    home,
    ".codex",
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  )
  await mkdir(dir, { recursive: true })

  const lines: string[] = [
    JSON.stringify({
      timestamp: iso,
      type: "session_meta",
      // cli_version is required by Codex's session-meta schema; without it
      // the resume machinery refuses the file outright.
      payload: { id: sessionId, timestamp: iso, cwd, originator: "mako", cli_version: "0.147.0", source: "exec" },
    }),
  ]
  for (const message of flatten(thread.entries)) {
    lines.push(
      JSON.stringify({
        timestamp: message.at ?? iso,
        type: "response_item",
        payload: {
          type: "message",
          role: message.role,
          content: [
            { type: message.role === "user" ? "input_text" : "output_text", text: message.text },
          ],
        },
      })
    )
  }

  const stamp = iso.slice(0, 19).replace(/:/g, "-")
  const path = join(dir, `rollout-${stamp}-${sessionId}.jsonl`)
  await writeFile(path, lines.join("\n") + "\n", "utf8")
  return { sessionId, path }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

/**
 * Write a thread into Grok's own store — a session directory holding the
 * transcript and the summary its CLI lists sessions by. `agent --resume <id>`
 * replays it. The user's words go inside a `<user_query>` tag because that
 * is where Grok's own scaffolding puts them, and its resume path expects to
 * find them there.
 */
export async function emitGrokSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const dir = join(home, ".grok", "sessions", encodeURIComponent(cwd), sessionId)
  await mkdir(dir, { recursive: true })

  const messages = flatten(thread.entries)
  const lines = messages.map((message) =>
    JSON.stringify(
      message.role === "user"
        ? { type: "user", content: [{ type: "text", text: `<user_query>\n${message.text}\n</user_query>` }] }
        : { type: "assistant", content: message.text }
    )
  )
  await writeFile(join(dir, "chat_history.jsonl"), `${lines.join("\n")}\n`, "utf8")
  await writeFile(
    join(dir, "summary.json"),
    JSON.stringify({
      info: { id: sessionId, cwd },
      session_summary: thread.ref.title ?? "Imported conversation",
      created_at: thread.ref.startedAt ?? now,
      updated_at: now,
      num_messages: messages.length,
      num_chat_messages: messages.length,
      current_model_id: "grok-4.6",
      chat_format_version: 1,
      next_trace_turn: 1,
    }),
    "utf8"
  )
  return { sessionId, path: join(dir, "chat_history.jsonl") }
}

/**
 * Write a thread into Cursor's store: content-addressed JSON blobs in
 * SQLite, ordered by a protobuf root. The root must carry the conversation's
 * time zone beside its timestamp — Cursor's resume rejects the file
 * otherwise, in so many words. Verified against `cursor-agent --resume`.
 */
export async function emitCursorSession(
  thread: Thread,
  options: EmitOptions = {}
): Promise<EmitResult> {
  const sqlite = await import("node:sqlite").catch(() => {
    throw new Error("Writing Cursor sessions needs Node's built-in SQLite (Node 22.5+)")
  })
  const { createHash } = await import("node:crypto")

  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const chatId = randomUUID()
  const workspaceHash = createHash("md5").update(cwd).digest("hex")
  const dir = join(home, ".cursor", "chats", workspaceHash, chatId)
  await mkdir(dir, { recursive: true })

  const database = new sqlite.DatabaseSync(join(dir, "store.db"))
  try {
    database.exec(
      "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    const put = database.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)")
    const hashes: Buffer[] = []
    for (const message of flatten(thread.entries)) {
      const data = Buffer.from(
        JSON.stringify(
          message.role === "user"
            ? {
                role: "user",
                content: [
                  { type: "text", text: `<user_query>\n${message.text}\n</user_query>` },
                ],
              }
            : { role: "assistant", content: [{ type: "text", text: message.text }] }
        )
      )
      const id = createHash("sha256").update(data).digest("hex")
      put.run(id, data)
      hashes.push(Buffer.from(id, "hex"))
    }

    const varint = (value: number | bigint): Buffer => {
      const bytes: number[] = []
      let current = BigInt(value)
      while (current > 127n) {
        bytes.push(Number(current & 0x7fn) | 0x80)
        current >>= 7n
      }
      bytes.push(Number(current))
      return Buffer.from(bytes)
    }
    const tag = (field: number, wire: number): Buffer => varint((field << 3) | wire)
    const bytesField = (field: number, buffer: Buffer): Buffer =>
      Buffer.concat([tag(field, 2), varint(buffer.length), buffer])

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const root = Buffer.concat([
      ...hashes.map((hash) => bytesField(1, hash)),
      bytesField(9, Buffer.from(`file://${cwd}`)),
      bytesField(22, Buffer.from("cli")),
      Buffer.concat([tag(26, 0), varint(Date.now())]),
      bytesField(27, Buffer.from(timeZone)),
    ])
    const rootId = createHash("sha256").update(root).digest("hex")
    put.run(rootId, root)

    const meta = {
      agentId: chatId,
      latestRootBlobId: rootId,
      name: thread.ref.title ?? "Imported conversation",
      mode: "agent",
      isRunEverything: false,
      createdAt: Date.now(),
    }
    database
      .prepare("INSERT INTO meta (key, value) VALUES ('0', ?)")
      .run(Buffer.from(JSON.stringify(meta)).toString("hex"))
  } finally {
    database.close()
  }

  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      createdAtMs: Date.now(),
      hasConversation: true,
      updatedAtMs: Date.now(),
      cwd,
    }),
    "utf8"
  )
  return { sessionId: chatId, path: join(dir, "store.db") }
}
