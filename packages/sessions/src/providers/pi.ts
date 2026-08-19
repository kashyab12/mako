/**
 * Pi coding-agent sessions.
 *
 * Native store: `~/.pi/agent/sessions/<cwd-slug>/<stamp>_<uuid>.jsonl`. The
 * header line is `{type:"session", version, id, timestamp, cwd}`; every
 * conversational line is `{type:"message", id, parentId, message}` with roles
 * `user`, `assistant` (content blocks: text / thinking / toolCall) and
 * `toolResult` (paired to its call by `toolCallId`). `model_change` and
 * `thinking_level_change` lines become events; `custom` lines are plugin
 * bookkeeping and are skipped.
 *
 * Pi sessions are trees — a fork writes a message whose `parentId` is an
 * earlier entry. Translation walks the file in order, which yields the last
 * active branch's history interleaved with abandoned ones; for cataloguing
 * and continuation that is the honest, cheap reading of the file. The native
 * store remains authoritative for tree navigation.
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

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue | undefined
}

interface PiLineBase {
  timestamp?: string
}

interface PiSessionLine extends PiLineBase {
  type: "session"
  id: string | null
  cwd?: string
}

interface PiModelChangeLine extends PiLineBase {
  type: "model_change"
  modelId?: string
  provider?: string
}

interface PiThinkingLevelChangeLine extends PiLineBase {
  type: "thinking_level_change"
  level?: string
}

interface PiMessageLine extends PiLineBase {
  type: "message"
  message: PiMessage
}

type PiLine =
  PiSessionLine | PiModelChangeLine | PiThinkingLevelChangeLine | PiMessageLine

interface PiTextPart {
  type: "text"
  text: string
}

interface PiThinkingPart {
  type: "thinking"
  thinking: string
}

interface PiToolCallPart {
  type: "toolCall"
  id?: string
  name: string
  arguments?: JsonValue
}

type PiContentPart = PiTextPart | PiThinkingPart | PiToolCallPart
type PiTextContent = string | PiContentPart[]

interface PiUserMessage {
  role: "user"
  content: PiTextContent
}

interface PiToolResultMessage {
  role: "toolResult"
  content: PiTextContent
  toolCallId?: string
}

interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costTotal: number
}

interface PiAssistantMessage {
  role: "assistant"
  content: PiContentPart[]
  model?: string
  usage?: PiUsage
}

type PiMessage = PiUserMessage | PiToolResultMessage | PiAssistantMessage
type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type ToolBlock = EntryBlock & { type: "tool" }

interface PiTranslator extends LineTranslator {
  done(): ThreadEntry[]
  commitBatch(): void
  readonly needsReset: boolean
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function parseContentPart(value: JsonValue): PiContentPart | null {
  if (!isJsonObject(value)) return null
  switch (stringValue(value["type"])) {
    case "text": {
      const text = stringValue(value["text"])
      return text === undefined ? null : { type: "text", text }
    }
    case "thinking": {
      const thinking = stringValue(value["thinking"])
      return thinking === undefined ? null : { type: "thinking", thinking }
    }
    case "toolCall":
      return {
        type: "toolCall",
        id: stringValue(value["id"]),
        name: String(value["name"] ?? "tool"),
        arguments: value["arguments"],
      }
    default:
      return null
  }
}

function parseTextContent(value: JsonValue | undefined): PiTextContent {
  if (isString(value)) return value
  if (!Array.isArray(value)) return []
  const parts: PiContentPart[] = []
  for (const item of value) {
    const part = parseContentPart(item)
    if (part) parts.push(part)
  }
  return parts
}

function parseUsage(value: JsonValue | undefined): PiUsage | undefined {
  if (!value) return undefined
  const usage = objectValue(value)
  const cost = objectValue(usage?.["cost"])
  return {
    input: Number(usage?.["input"] ?? 0),
    output: Number(usage?.["output"] ?? 0),
    cacheRead: Number(usage?.["cacheRead"] ?? 0),
    cacheWrite: Number(usage?.["cacheWrite"] ?? 0),
    costTotal: Number(cost?.["total"] ?? 0),
  }
}

function parseMessage(value: JsonValue | undefined): PiMessage | null {
  const message = objectValue(value)
  if (!message) return null
  switch (stringValue(message["role"])) {
    case "user":
      return { role: "user", content: parseTextContent(message["content"]) }
    case "toolResult":
      return {
        role: "toolResult",
        content: parseTextContent(message["content"]),
        toolCallId: stringValue(message["toolCallId"]),
      }
    case "assistant": {
      const content = parseTextContent(message["content"])
      return {
        role: "assistant",
        content: Array.isArray(content) ? content : [],
        model: stringValue(message["model"]),
        usage: parseUsage(message["usage"]),
      }
    }
    default:
      return null
  }
}

function parsePiLine(raw: string): PiLine | null {
  const value = parseLine(raw)
  if (!value) return null
  const timestamp = stringValue(value["timestamp"])
  switch (stringValue(value["type"])) {
    case "session":
      return {
        type: "session",
        id: stringValue(value["id"]) ?? null,
        cwd: stringValue(value["cwd"]),
        timestamp,
      }
    case "model_change":
      return {
        type: "model_change",
        modelId: stringValue(value["modelId"]),
        provider: stringValue(value["provider"]),
        timestamp,
      }
    case "thinking_level_change":
      return {
        type: "thinking_level_change",
        level: stringValue(value["level"]),
        timestamp,
      }
    case "message": {
      const message = parseMessage(value["message"])
      return message ? { type: "message", message, timestamp } : null
    }
    default:
      return null
  }
}

function plainText(content: PiTextContent): string {
  if (!Array.isArray(content)) return content
  return content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

export class PiProvider implements SessionProvider {
  harness = "pi" as const
  displayName = "Pi"
  private root: string

  constructor(home = homedir()) {
    this.root = join(home, ".pi", "agent", "sessions")
  }

  roots(): string[] {
    return [this.root]
  }

  async discover(): Promise<NativeFile[]> {
    const paths = await walkFiles(
      this.root,
      (name) => name.endsWith(".jsonl"),
      2
    )
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
    const head = await readHead(file.path, 131_072)
    let ref: ThreadRef | null = null
    for (const raw of head.split("\n")) {
      const line = parsePiLine(raw)
      if (!line) continue
      if (line.type === "session") {
        if (line.id === null) return null
        ref = {
          harness: this.harness,
          nativeId: line.id,
          path: file.path,
          cwd: line.cwd,
          startedAt: line.timestamp,
          updatedAt: new Date(file.mtimeMs).toISOString(),
          bytes: file.bytes,
        }
        continue
      }
      if (!ref) continue
      if (line.type === "model_change") {
        if (line.modelId !== undefined) ref.model = line.modelId
        if (line.provider !== undefined) ref.modelProvider = line.provider
      }
      if (
        !ref.title &&
        line.type === "message" &&
        line.message.role === "user"
      ) {
        ref.title = titleFrom(plainText(line.message.content))
        if (ref.title) break
      }
    }
    return ref
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

function translator(): PiTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const toolsById = new Map<string, ToolBlock>()
  let started = false
  let needsReset = false

  const push = (raw: string): void => {
    const line = parsePiLine(raw)
    if (!line) return

    if (line.type === "model_change") {
      sink.push({
        kind: "event",
        at: line.timestamp,
        label: "Model changed",
        detail:
          [line.provider, line.modelId].filter(Boolean).join(" · ") ||
          undefined,
      })
      return
    }
    if (line.type === "thinking_level_change") {
      sink.push({
        kind: "event",
        at: line.timestamp,
        label: "Thinking level",
        detail: line.level,
      })
      return
    }
    if (line.type !== "message") return
    const message = line.message

    if (message.role === "user") {
      const text = plainText(message.content)
      if (!text.trim()) return
      assistant = null
      started = true
      sink.push({ kind: "user", at: line.timestamp, text })
      return
    }

    if (message.role === "toolResult") {
      const id = message.toolCallId ?? ""
      const block = toolsById.get(id)
      if (block) {
        block.output = clip(plainText(message.content))
        toolsById.delete(id)
      } else if (id) {
        needsReset = true
      }
      return
    }

    if (!started) needsReset = true
    started = true
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
        case "toolCall": {
          const block: ToolBlock = {
            type: "tool",
            name: part.name,
            input: clip(
              part.arguments === undefined
                ? undefined
                : JSON.stringify(part.arguments)
            ),
          }
          if (part.id !== undefined) toolsById.set(part.id, block)
          turn.blocks.push(block)
          break
        }
      }
    }
    const usage = message.usage
    if (usage) {
      turn.usage = {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        costUsd: usage.costTotal || undefined,
      }
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
