/**
 * Codex CLI sessions.
 *
 * Native store: `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`.
 * Each line is `{timestamp, type, payload}` where the interesting types are:
 *
 *   * `session_meta`   — id, cwd, CLI version; always the first line
 *   * `turn_context`   — per-turn model and effort
 *   * `response_item`  — the transcript proper, as OpenAI Responses items:
 *                        message / reasoning / function_call / function_call_output
 *   * `event_msg`      — streaming milestones; `user_message` and
 *                        `token_count` are used here, the rest are echoes of
 *                        response items and are skipped to avoid doubling
 *
 * User turns are read from `response_item` messages rather than `user_message`
 * events, because resumed sessions replay history only as response items —
 * but Codex also injects instructions and environment context as user-role
 * messages, so tag-wrapped injections are filtered out.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { stat } from "node:fs/promises"
import {
  clip,
  titleFrom,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
  type TurnUsage,
} from "../format.js"
import { parseLine, readLines, walkFiles } from "../jsonl.js"
import type { NativeFile, SessionProvider } from "./types.js"

/**
 * Injections Codex writes as user-role messages that no user typed: context
 * blocks wrapped in a snake_case tag (`<environment_context>`,
 * `<user_instructions>`, `<recommended_plugins>`, …) and the attachment
 * manifest. The tag rule requires an underscore so pasted HTML that opens
 * with `<div>` is still a real prompt.
 */
const INJECTED = /^(?:<[a-z]+(?:_[a-z0-9]+)+>|# Files mentioned by the user:)/i

interface CodexLine {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const rec = part as Record<string, unknown>
      return typeof rec?.text === "string" ? rec.text : ""
    })
    .join("")
}

export class CodexProvider implements SessionProvider {
  harness = "codex" as const
  displayName = "Codex"
  private root: string

  constructor(home = homedir()) {
    this.root = join(home, ".codex", "sessions")
  }

  roots(): string[] {
    return [this.root]
  }

  async discover(): Promise<NativeFile[]> {
    const paths = await walkFiles(this.root, (name) => name.endsWith(".jsonl"))
    const files = await Promise.all(
      paths.map(async (path) => {
        try {
          const info = await stat(path)
          return { path, bytes: info.size, mtimeMs: info.mtimeMs }
        } catch {
          return null
        }
      })
    )
    return files.filter((file): file is NativeFile => file !== null)
  }

  /**
   * Bounded, but not fixed: the meta line comes first, while the first *real*
   * user message can sit megabytes in, behind injected instruction blocks
   * and attachment manifests. The peek streams lines and stops the moment it
   * has an id, a model and a title — or at the byte budget, whichever comes
   * first. An 8 MB budget titles every session observed in the wild without
   * ever making a changed gigabyte file cost a gigabyte.
   */
  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const budget = 8 * 1024 * 1024
    let spent = 0
    let sawMeta = false
    let ref: ThreadRef | null = null
    await readLines(file.path, 0, (raw) => {
      spent += raw.length + 1
      const line = parseLine(raw) as CodexLine | null
      if (!line?.type) return spent < budget
      const payload = line.payload ?? {}
      if (line.type === "session_meta") {
        sawMeta = true
        const id = String(payload.id ?? payload.session_id ?? "")
        if (!id) return false
        ref = {
          harness: this.harness,
          nativeId: id,
          path: file.path,
          cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
          startedAt: typeof payload.timestamp === "string" ? payload.timestamp : line.timestamp,
          updatedAt: new Date(file.mtimeMs).toISOString(),
          bytes: file.bytes,
        }
        return spent < budget
      }
      if (!sawMeta) return false // Not a rollout file at all.
      if (!ref) return spent < budget
      if (line.type === "turn_context" && !ref.model && typeof payload.model === "string") {
        ref.model = payload.model
      }
      if (!ref.title) {
        if (line.type === "event_msg" && payload.type === "user_message") {
          const text = String(payload.message ?? "")
          if (!INJECTED.test(text.trimStart())) ref.title = titleFrom(text)
        }
        if (line.type === "response_item" && payload.type === "message" && payload.role === "user") {
          const text = textOf(payload.content)
          if (!INJECTED.test(text.trimStart())) ref.title = titleFrom(text)
        }
      }
      return spent < budget && !(ref.title && ref.model)
    })
    return ref
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const native: NativeFile = { path, bytes: file.size, mtimeMs: file.mtimeMs }
    const ref = await this.peek(native)
    if (!ref) return null
    const into = translator()
    await readLines(path, 0, into.push)
    return { ref, entries: into.done() }
  }

  async tail(path: string, fromByte: number): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = translator()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }
}

/**
 * Turn raw rollout lines into canonical entries, one line at a time.
 *
 * Function calls and their outputs are paired by `call_id` and merged into a
 * single tool block on the current assistant turn. A `token_count` event
 * closes over the most recent assistant entry, which is the turn it priced.
 * Push-based so a gigabyte session streams through without ever being held.
 */
function translator(): { push: (raw: string) => void; done: () => ThreadEntry[] } {
  type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const callsByid = new Map<string, EntryBlock & { type: "tool" }>()
  let model: string | undefined

  const openAssistant = (at?: string): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", at, model, blocks: [] }
      sink.push(assistant)
    }
    return assistant
  }

  const push = (raw: string): void => {
    const line = parseLine(raw) as CodexLine | null
    if (!line?.type) return
    const payload = line.payload ?? {}

    if (line.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model
      return
    }

    if (line.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info as Record<string, unknown> | undefined
      const last = info?.last_token_usage as Record<string, unknown> | undefined
      const turn = assistant as AssistantEntry | null
      if (last && turn) {
        const usage: TurnUsage = {
          input: Number(last.input_tokens ?? 0),
          output: Number(last.output_tokens ?? 0),
          cacheRead: Number(last.cached_input_tokens ?? 0),
          cacheWrite: Number(last.cache_write_input_tokens ?? 0),
        }
        turn.usage = usage
      }
      return
    }

    if (line.type !== "response_item") return

    switch (payload.type) {
      case "message": {
        const text = textOf(payload.content)
        if (payload.role === "user") {
          if (INJECTED.test(text.trimStart()) || !text.trim()) return
          assistant = null
          sink.push({ kind: "user", at: line.timestamp, text })
        } else if (payload.role === "assistant" && text) {
          openAssistant(line.timestamp).blocks.push({ type: "text", text })
        }
        // Developer/system messages are harness plumbing; skipped.
        return
      }
      case "reasoning": {
        const summary = textOf(payload.summary) || textOf(payload.content)
        if (summary.trim()) {
          openAssistant(line.timestamp).blocks.push({ type: "thinking", text: summary })
        }
        return
      }
      case "function_call": {
        const block: EntryBlock & { type: "tool" } = {
          type: "tool",
          name: String(payload.name ?? "tool"),
          input: clip(typeof payload.arguments === "string" ? payload.arguments : undefined),
        }
        if (typeof payload.call_id === "string") callsByid.set(payload.call_id, block)
        openAssistant(line.timestamp).blocks.push(block)
        return
      }
      case "function_call_output": {
        const id = typeof payload.call_id === "string" ? payload.call_id : ""
        const block = callsByid.get(id)
        const output = payload.output
        const text =
          typeof output === "string"
            ? output
            : typeof (output as Record<string, unknown>)?.content === "string"
              ? String((output as Record<string, unknown>).content)
              : JSON.stringify(output ?? "")
        if (block) {
          block.output = clip(text)
          callsByid.delete(id)
        }
        return
      }
    }
  }

  return { push, done: () => sink.done() }
}
