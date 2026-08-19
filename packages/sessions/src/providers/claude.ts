/**
 * Claude Code sessions.
 *
 * Native store: `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`. Lines
 * are heterogeneous: `user` / `assistant` carry the conversation as
 * Anthropic-format messages; `summary`, `file-history-snapshot`, mode records
 * and hook records are bookkeeping. Tool use pairs an assistant `tool_use`
 * block with a later user-role `tool_result` block by id. Subagent traffic is
 * marked `isSidechain` and is skipped — a sidechain is the agent's internal
 * conversation, not the user's.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import {
  clip,
  titleFrom,
  EntrySink,
  type EntryBlock,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "../format.js"
import { createJsonlFollower, parseLine, readHead, readLines, snapshotSink, walkFiles } from "../jsonl.js"
import type { NativeFile, SessionProvider } from "./types.js"

interface ClaudeLine {
  type?: string
  uuid?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  message?: { role?: string; model?: string; content?: unknown; usage?: Record<string, unknown> }
}

/** Text a user line starts with when the harness, not the user, wrote it. */
const NOT_A_PROMPT = /^(?:<(?:command-name|command-message|local-command|system-reminder|task-notification)|Caveat: )/

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

export class ClaudeProvider implements SessionProvider {
  harness = "claude" as const
  displayName = "Claude Code"
  private root: string
  private home: string
  private extraRoots: { at: number; value: string[] } | null = null

  constructor(home = homedir()) {
    this.home = home
    this.root = join(home, ".claude", "projects")
  }

  /**
   * Claude does not always live in ~/.claude. A CLAUDE_CONFIG_DIR moves the
   * whole store; router setups (subrouter and friends) fan Claude out into
   * per-profile homes like ~/.subrouter/<x>/claude/<id>/projects — sessions
   * as real as any, invisible to a provider that only knows the default
   * path. Roots therefore are: the default, the env override, anything
   * declared in ~/.mako/roots.json ({"claude": ["/abs/projects", …]}), and
   * auto-discovered subrouter profiles. Discovery is a couple of readdirs,
   * cached briefly — roots() is called on every watch/scan setup.
   */
  roots(): string[] {
    if (this.extraRoots && Date.now() - this.extraRoots.at < 60_000) {
      return [this.root, ...this.extraRoots.value]
    }
    const extras: string[] = []
    // Identity is the *real* path: router setups symlink their per-profile
    // projects dirs straight back at ~/.claude/projects, and scanning the
    // same store through five names lists every session five times.
    const seen = new Set<string>()
    const realOf = (dir: string): string => {
      try {
        return realpathSync(dir)
      } catch {
        return dir
      }
    }
    if (existsSync(this.root)) seen.add(realOf(this.root))
    const push = (dir: string) => {
      if (!dir || !existsSync(dir)) return
      const real = realOf(dir)
      if (seen.has(real)) return
      seen.add(real)
      extras.push(real)
    }
    const env = process.env["CLAUDE_CONFIG_DIR"]
    if (env) push(join(env, "projects"))
    try {
      const declared = JSON.parse(
        readFileSync(join(this.home, ".mako", "roots.json"), "utf8")
      ) as { claude?: string[] }
      for (const dir of declared.claude ?? []) push(dir)
    } catch {
      // No declaration file: nothing declared.
    }
    try {
      const subrouter = join(this.home, ".subrouter")
      for (const group of readdirSync(subrouter)) {
        const claudeDir = join(subrouter, group, "claude")
        if (!existsSync(claudeDir)) continue
        for (const profile of readdirSync(claudeDir)) {
          push(join(claudeDir, profile, "projects"))
        }
      }
    } catch {
      // No subrouter: the common case.
    }
    this.extraRoots = { at: Date.now(), value: extras }
    return [this.root, ...extras]
  }

  async discover(): Promise<NativeFile[]> {
    const paths = (
      await Promise.all(
        this.roots().map((root) => walkFiles(root, (name) => name.endsWith(".jsonl"), 2))
      )
    ).flat()
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

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const head = await readHead(file.path, 262_144)
    const ref: ThreadRef = {
      harness: this.harness,
      nativeId: "",
      path: file.path,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      bytes: file.bytes,
    }
    for (const raw of head.split("\n")) {
      const line = parseLine(raw) as ClaudeLine | null
      if (!line?.type) continue
      if (!ref.nativeId && typeof line.sessionId === "string") ref.nativeId = line.sessionId
      if (!ref.cwd && typeof line.cwd === "string") ref.cwd = line.cwd
      if (!ref.startedAt && typeof line.timestamp === "string") ref.startedAt = line.timestamp
      if (!ref.model && line.type === "assistant" && typeof line.message?.model === "string") {
        ref.model = line.message.model
      }
      if (!ref.title && line.type === "user" && !line.isSidechain && !line.isMeta) {
        const text = plainText(line.message?.content)
        if (text.trim() && !NOT_A_PROMPT.test(text.trimStart())) ref.title = titleFrom(text)
      }
      if (ref.nativeId && ref.title && ref.model) break
    }
    // A session file with no session id yet is a placeholder, not a session.
    return ref.nativeId ? ref : null
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
    const line = parseLine(raw) as ClaudeLine | null
    if (!line?.type || line.isSidechain) return

    if (line.type === "summary") return

    if (line.type === "user") {
      const content = line.message?.content
      // Tool results ride user-role messages; attach them to their calls
      // rather than showing them as turns the user took.
      if (Array.isArray(content)) {
        let onlyResults = true
        for (const part of content) {
          const rec = part as Record<string, unknown>
          if (rec?.type !== "tool_result") {
            onlyResults = false
            continue
          }
          const id = typeof rec.tool_use_id === "string" ? rec.tool_use_id : ""
          const block = toolsById.get(id)
          if (block) {
            block.output = clip(plainText(rec.content) || (typeof rec.content === "string" ? rec.content : ""))
            if (rec.is_error === true) block.error = true
            toolsById.delete(id)
          }
        }
        if (onlyResults) return
      }
      if (line.isMeta) return
      if (line.isCompactSummary) {
        sink.push({ kind: "event", at: line.timestamp, label: "Compacted", detail: undefined })
        assistant = null
        return
      }
      const text = plainText(content)
      if (!text.trim() || NOT_A_PROMPT.test(text.trimStart())) return
      assistant = null
      sink.push({ kind: "user", at: line.timestamp, text })
      return
    }

    if (line.type !== "assistant") return
    const message = line.message
    if (!message || !Array.isArray(message.content)) return
    if (!assistant) {
      assistant = { kind: "assistant", at: line.timestamp, model: message.model, blocks: [] }
      sink.push(assistant)
    }
    const turn: AssistantEntry = assistant
    for (const part of message.content) {
      const rec = part as Record<string, unknown>
      switch (rec?.type) {
        case "text":
          if (typeof rec.text === "string" && rec.text) {
            turn.blocks.push({ type: "text", text: rec.text })
          }
          break
        case "thinking":
          if (typeof rec.thinking === "string" && rec.thinking) {
            turn.blocks.push({ type: "thinking", text: rec.thinking })
          }
          break
        case "tool_use": {
          const block: EntryBlock & { type: "tool" } = {
            type: "tool",
            name: String(rec.name ?? "tool"),
            input: clip(rec.input === undefined ? undefined : JSON.stringify(rec.input)),
          }
          if (typeof rec.id === "string") toolsById.set(rec.id, block)
          turn.blocks.push(block)
          break
        }
      }
    }
    const usage = message.usage
    if (usage) {
      turn.usage = {
        input: Number(usage.input_tokens ?? 0),
        output: Number(usage.output_tokens ?? 0),
        cacheRead: Number(usage.cache_read_input_tokens ?? 0),
        cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
      }
    }
  }

  return { push, snapshot: () => snapshotSink(sink), done: () => snapshotSink(sink) }
}
