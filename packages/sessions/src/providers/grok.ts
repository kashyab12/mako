/**
 * Grok CLI ("agent") sessions.
 *
 * Native store: `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/` holding
 * `chat_history.jsonl` (the transcript) and `summary.json` (id, cwd, a
 * server-written title, timestamps, current model) — the cheapest peek of
 * any harness, since the summary answers everything without touching the
 * transcript.
 *
 * Transcript lines are `{type: system|user|reasoning|assistant|tool_result|
 * backend_tool_call}`. The user's actual words live inside a `<user_query>`
 * tag; user lines without one are injected context (`<user_info>`,
 * `<system-reminder>`, git status) and are skipped. Assistant lines carry a
 * plain-text `content` plus `tool_calls`; results pair by `tool_call_id`.
 */

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { readdir, readFile, stat } from "node:fs/promises"
import {
  clip,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import { createJsonlFollower, parseLine, readLines, snapshotSink } from "../jsonl.js"
import type { NativeFile, SessionProvider } from "./types.js"

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/

interface GrokLine {
  type?: string
  content?: unknown
  summary?: unknown
  tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>
  tool_call_id?: string
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const rec = part as Record<string, unknown>
      return typeof rec?.text === "string" ? rec.text : ""
    })
    .join("")
}

export class GrokProvider implements SessionProvider {
  harness = "grok" as const
  displayName = "Grok"
  private root: string

  constructor(home = homedir()) {
    this.root = join(home, ".grok", "sessions")
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
          return // A stray file such as prompt_history.jsonl, not a directory.
        }
        await Promise.all(
          sessions.map(async (session) => {
            const path = join(this.root, workspace, session, "chat_history.jsonl")
            try {
              const info = await stat(path)
              files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
            } catch {
              // A session directory without a transcript yet.
            }
          })
        )
      })
    )
    return files
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const raw = await readFile(join(dirname(file.path), "summary.json"), "utf8").catch(() => null)
    if (!raw) return null
    try {
      const summary = JSON.parse(raw) as {
        info?: { id?: string; cwd?: string }
        session_summary?: string
        created_at?: string
        updated_at?: string
        current_model_id?: string
      }
      const id = summary.info?.id
      if (!id) return null
      return {
        harness: this.harness,
        nativeId: id,
        path: file.path,
        cwd: summary.info?.cwd,
        title: summary.session_summary || undefined,
        model: summary.current_model_id,
        startedAt: summary.created_at,
        updatedAt: summary.updated_at ?? new Date(file.mtimeMs).toISOString(),
        bytes: file.bytes,
      }
    } catch {
      return null
    }
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const ref = await this.peek({ path, bytes: file.size, mtimeMs: file.mtimeMs })
    if (!ref) return null
    const into = translator()
    await readLines(path, 0, into.push)
    return { ref, entries: into.done() }
  }

  createFollower(path: string, fromByte: number) {
    return createJsonlFollower(path, fromByte, translator)
  }

  async tail(path: string, fromByte: number): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = translator()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }
}

function translator(): {
  push: (raw: string) => void
  snapshot: () => ThreadEntry[]
  done: () => ThreadEntry[]
} {
  type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const toolsById = new Map<string, EntryBlock & { type: "tool" }>()

  const push = (raw: string): void => {
    const line = parseLine(raw) as GrokLine | null
    if (!line?.type) return

    switch (line.type) {
      case "user": {
        const text = plainText(line.content)
        const query = USER_QUERY.exec(text)
        if (!query) return // Injected context, not something the user typed.
        const spoken = (query[1] ?? "").trim()
        if (!spoken) return
        assistant = null
        sink.push({ kind: "user", text: spoken })
        return
      }
      case "reasoning": {
        const summary = plainText(line.summary)
        if (summary.trim()) {
          if (!assistant) {
            assistant = { kind: "assistant", blocks: [] }
            sink.push(assistant)
          }
          assistant.blocks.push({ type: "thinking", text: summary })
        }
        return
      }
      case "assistant": {
        if (!assistant) {
          assistant = { kind: "assistant", blocks: [] }
          sink.push(assistant)
        }
        const text = typeof line.content === "string" ? line.content : plainText(line.content)
        if (text.trim()) assistant.blocks.push({ type: "text", text })
        for (const call of line.tool_calls ?? []) {
          const block: EntryBlock & { type: "tool" } = {
            type: "tool",
            name: String(call.name ?? "tool"),
            input: clip(call.arguments),
          }
          if (typeof call.id === "string") toolsById.set(call.id, block)
          assistant.blocks.push(block)
        }
        return
      }
      case "tool_result": {
        const id = typeof line.tool_call_id === "string" ? line.tool_call_id : ""
        const block = toolsById.get(id)
        if (block) {
          block.output = clip(plainText(line.content))
          toolsById.delete(id)
        }
        return
      }
    }
  }
  return { push, snapshot: () => snapshotSink(sink), done: () => snapshotSink(sink) }
}
