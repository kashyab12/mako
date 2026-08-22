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
import {
  createJsonlFollower,
  parseLine,
  readHead,
  readLines,
  snapshotSink,
  walkFiles,
  type LineTranslator,
} from "../jsonl.js"
import type { NativeFile, SessionProvider } from "./types.js"

type ClaudeJsonScalar = boolean | number | string | null
type ClaudeJsonValue = ClaudeJsonScalar | ClaudeJsonObject | ClaudeJsonValue[]

interface ClaudeJsonObject {
  [key: string]: ClaudeJsonValue | undefined
}

interface ClaudeTextContent {
  type: "text"
  text?: string
}

interface ClaudeThinkingContent {
  type: "thinking"
  thinking?: string
}

interface ClaudeToolUseContent {
  type: "tool_use"
  id?: string
  name: string
  input?: ClaudeJsonValue
}

interface ClaudeToolResultContent {
  type: "tool_result"
  toolUseId: string
  content?: ClaudeContent
  isError: boolean
}

interface ClaudeOtherContent {
  type: "other"
}

type ClaudeContentBlock =
  | ClaudeTextContent
  | ClaudeThinkingContent
  | ClaudeToolUseContent
  | ClaudeToolResultContent
  | ClaudeOtherContent
type ClaudeContent = string | ClaudeContentBlock[]

interface ClaudeUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface ClaudeMessage {
  role?: string
  model?: string
  content?: ClaudeContent
  usage?: ClaudeUsage
}

interface ClaudeLine {
  type: string
  uuid?: string
  timestamp?: string
  sessionId?: string
  cwd?: string
  isSidechain: boolean
  isMeta: boolean
  isCompactSummary: boolean
  isAbortedMidStream: boolean
  message?: ClaudeMessage
}

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type ClaudeToolBlock = EntryBlock & { type: "tool" }

interface ClaudeTranslator extends LineTranslator {
  done(): ThreadEntry[]
}

/** Text a user line starts with when the harness, not the user, wrote it. */
const NOT_A_PROMPT =
  /^(?:<(?:command-name|command-message|local-command|system-reminder|task-notification)|Caveat: )/

function isString(value: ClaudeJsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isJsonObject(
  value: ClaudeJsonValue | undefined
): value is ClaudeJsonObject {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function stringValue(value: ClaudeJsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function parseContentBlock(value: ClaudeJsonValue): ClaudeContentBlock {
  if (!isJsonObject(value)) return { type: "other" }
  switch (stringValue(value["type"])) {
    case "text":
      return { type: "text", text: stringValue(value["text"]) }
    case "thinking":
      return { type: "thinking", thinking: stringValue(value["thinking"]) }
    case "tool_use":
      return {
        type: "tool_use",
        id: stringValue(value["id"]),
        name: String(value["name"] ?? "tool"),
        input: value["input"],
      }
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: stringValue(value["tool_use_id"]) ?? "",
        content: parseContent(value["content"]),
        isError: value["is_error"] === true,
      }
    default:
      return { type: "other" }
  }
}

function parseContent(
  value: ClaudeJsonValue | undefined
): ClaudeContent | undefined {
  if (isString(value)) return value
  if (!Array.isArray(value)) return undefined
  return value.map(parseContentBlock)
}

function tokenCount(value: ClaudeJsonValue | undefined): number {
  return Number(value ?? 0)
}

function parseUsage(
  value: ClaudeJsonValue | undefined
): ClaudeUsage | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    input: tokenCount(value["input_tokens"]),
    output: tokenCount(value["output_tokens"]),
    cacheRead: tokenCount(value["cache_read_input_tokens"]),
    cacheWrite: tokenCount(value["cache_creation_input_tokens"]),
  }
}

function parseMessage(
  value: ClaudeJsonValue | undefined
): ClaudeMessage | undefined {
  if (!isJsonObject(value)) return undefined
  return {
    role: stringValue(value["role"]),
    model: stringValue(value["model"]),
    content: parseContent(value["content"]),
    usage: parseUsage(value["usage"]),
  }
}

function parseClaudeLine(raw: string): ClaudeLine | null {
  const root = parseLine(raw)
  if (!root) return null
  const type = stringValue(root["type"])
  if (!type) return null
  return {
    type,
    uuid: stringValue(root["uuid"]),
    timestamp: stringValue(root["timestamp"]),
    sessionId: stringValue(root["sessionId"]),
    cwd: stringValue(root["cwd"]),
    isSidechain: root["isSidechain"] === true,
    isMeta: root["isMeta"] === true,
    isCompactSummary: root["isCompactSummary"] === true,
    isAbortedMidStream: root["isAbortedMidStream"] === true,
    message: parseMessage(root["message"]),
  }
}

function parseDeclaredRoots(raw: string): string[] {
  try {
    const parsed: ClaudeJsonValue = JSON.parse(raw)
    if (!isJsonObject(parsed)) return []
    const roots = parsed["claude"]
    if (!Array.isArray(roots)) return []
    return roots.flatMap((root) => {
      const path = stringValue(root)
      return path === undefined ? [] : [path]
    })
  } catch {
    return []
  }
}

function plainText(content: ClaudeContent | undefined): string {
  if (!Array.isArray(content)) return content ?? ""
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
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
      const declared = parseDeclaredRoots(
        readFileSync(join(this.home, ".mako", "roots.json"), "utf8")
      )
      for (const dir of declared) push(dir)
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
        this.roots().map((root) =>
          walkFiles(root, (name) => name.endsWith(".jsonl"), 2)
        )
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
      const line = parseClaudeLine(raw)
      if (!line) continue
      if (!ref.nativeId && line.sessionId !== undefined)
        ref.nativeId = line.sessionId
      if (!ref.cwd && line.cwd !== undefined) ref.cwd = line.cwd
      if (!ref.startedAt && line.timestamp !== undefined)
        ref.startedAt = line.timestamp
      if (
        !ref.model &&
        line.type === "assistant" &&
        line.message?.model !== undefined
      ) {
        ref.model = line.message.model
      }
      if (
        !ref.title &&
        line.type === "user" &&
        !line.isSidechain &&
        !line.isMeta
      ) {
        const text = plainText(line.message?.content)
        if (text.trim() && !NOT_A_PROMPT.test(text.trimStart()))
          ref.title = titleFrom(text)
      }
      if (ref.nativeId && ref.title && ref.model) break
    }
    // A session file with no session id yet is a placeholder, not a session.
    return ref.nativeId ? ref : null
  }

  async read(path: string): Promise<Thread | null> {
    const file = await stat(path).catch(() => null)
    if (!file) return null
    const ref = await this.peek({
      path,
      bytes: file.size,
      mtimeMs: file.mtimeMs,
    })
    if (!ref) return null
    const into = translator()
    await readLines(path, 0, into.push)
    return { ref, entries: into.done() }
  }

  createFollower(path: string, fromByte: number) {
    return createJsonlFollower(path, fromByte, translator)
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }> {
    const into = translator()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }
}

function translator(): ClaudeTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const toolsById = new Map<string, ClaudeToolBlock>()
  let started = false
  let needsReset = false

  const push = (raw: string): void => {
    const line = parseClaudeLine(raw)
    if (!line || line.isSidechain) return

    if (line.type === "summary") return

    if (line.type === "user") {
      const content = line.message?.content
      // Tool results ride user-role messages; attach them to their calls
      // rather than showing them as turns the user took.
      if (Array.isArray(content)) {
        let onlyResults = true
        for (const part of content) {
          if (part.type !== "tool_result") {
            onlyResults = false
            continue
          }
          const block = toolsById.get(part.toolUseId)
          if (block) {
            block.output = clip(plainText(part.content))
            if (part.isError) block.error = true
            toolsById.delete(part.toolUseId)
          } else if (part.toolUseId) {
            needsReset = true
          }
        }
        if (onlyResults) return
      }
      if (line.isMeta) return
      if (line.isCompactSummary) {
        sink.push({
          kind: "event",
          at: line.timestamp,
          label: "Compacted",
          detail: undefined,
        })
        assistant = null
        return
      }
      const text = plainText(content)
      if (!text.trim() || NOT_A_PROMPT.test(text.trimStart())) return
      assistant = null
      started = true
      sink.push({ kind: "user", at: line.timestamp, text })
      return
    }

    if (line.type !== "assistant") return
    if (!started) needsReset = true
    started = true
    const message = line.message
    if (!message || !Array.isArray(message.content)) {
      if (line.isAbortedMidStream) {
        sink.push({ kind: "event", at: line.timestamp, label: "Interrupted" })
      }
      return
    }
    if (!assistant) {
      assistant = {
        kind: "assistant",
        at: line.timestamp,
        model: message.model,
        blocks: [],
      }
      sink.push(assistant)
    }
    const turn: AssistantEntry = assistant
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (part.text) turn.blocks.push({ type: "text", text: part.text })
          break
        case "thinking":
          if (part.thinking)
            turn.blocks.push({ type: "thinking", text: part.thinking })
          break
        case "tool_use": {
          const block: ClaudeToolBlock = {
            type: "tool",
            name: part.name,
            input: clip(
              part.input === undefined ? undefined : JSON.stringify(part.input)
            ),
          }
          if (part.id !== undefined) toolsById.set(part.id, block)
          turn.blocks.push(block)
          break
        }
      }
    }
    if (message.usage) turn.usage = message.usage
    if (line.isAbortedMidStream) {
      sink.push({ kind: "event", at: line.timestamp, label: "Interrupted" })
      assistant = null
      toolsById.clear()
    }
  }

  return {
    push,
    snapshot: () => snapshotSink(sink),
    done: () => snapshotSink(sink),
    commitBatch: () => {
      assistant = null
    },
    get needsReset() {
      return needsReset
    },
  }
}
