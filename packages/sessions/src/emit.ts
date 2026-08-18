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

interface Message {
  role: "user" | "assistant"
  text: string
  at?: string
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
  return messages
}

/**
 * Write a thread into Claude Code's own store, resumable by session id with
 * `claude --resume` or loaded live over ACP.
 */
export async function emitClaudeSession(
  thread: Thread,
  options: { cwd?: string; home?: string } = {}
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
    lines.push(
      JSON.stringify({
        type: message.role,
        uuid,
        parentUuid,
        sessionId,
        timestamp: message.at ?? new Date().toISOString(),
        cwd,
        isSidechain: false,
        ...(message.role === "user" ? { userType: "external" } : {}),
        message: {
          role: message.role,
          ...(message.role === "assistant" ? { model: "imported" } : {}),
          content: [{ type: "text", text: message.text }],
        },
      })
    )
    parentUuid = uuid
  }

  const path = join(dir, `${sessionId}.jsonl`)
  await writeFile(path, `${lines.join("\n")}\n`, "utf8")
  return { sessionId, path }
}

/**
 * Write a thread into Pi's own store, openable as a native session — full
 * history in the transcript and in the next prompt's context, no handoff
 * preamble anywhere.
 */
export async function emitPiSession(
  thread: Thread,
  options: { cwd?: string; home?: string } = {}
): Promise<EmitResult> {
  const cwd = options.cwd ?? thread.ref.cwd ?? homedir()
  const home = options.home ?? homedir()
  const sessionId = randomUUID()
  const startedAt = thread.ref.startedAt ?? new Date().toISOString()
  const slug = `-${cwd.replace(/\//g, "-")}--`
  const dir = join(home, ".pi", "agent", "sessions", slug)
  await mkdir(dir, { recursive: true })

  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: startedAt, cwd }),
  ]
  let parentId: string | null = null
  for (const message of flatten(thread.entries)) {
    const id = randomUUID().slice(0, 8)
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: message.at ?? new Date().toISOString(),
        message:
          message.role === "user"
            ? { role: "user", content: [{ type: "text", text: message.text }], timestamp: Date.parse(message.at ?? "") || Date.now() }
            : {
                role: "assistant",
                content: [{ type: "text", text: message.text }],
                api: "imported",
                provider: "imported",
                model: thread.ref.model ?? "imported",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop",
                timestamp: Date.parse(message.at ?? "") || Date.now(),
              },
      })
    )
    parentId = id
  }

  const stamp = startedAt.replace(/[:.]/g, "-")
  const path = join(dir, `${stamp}_${sessionId}.jsonl`)
  await writeFile(path, `${lines.join("\n")}\n`, "utf8")
  return { sessionId, path }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}
