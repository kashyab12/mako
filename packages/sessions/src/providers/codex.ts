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
import {
  createJsonlFollower,
  parseLine,
  readLines,
  snapshotSink,
  walkFiles,
  type LineTranslator,
} from "../jsonl.js"
import type { NativeFile, SessionProvider } from "./types.js"

/**
 * Injections Codex writes as user-role messages that no user typed: context
 * blocks wrapped in a snake_case tag (`<environment_context>`,
 * `<user_instructions>`, `<recommended_plugins>`, …) and the attachment
 * manifest. The tag rule requires an underscore so pasted HTML that opens
 * with `<div>` is still a real prompt.
 */
const INJECTED = /^(?:<[a-z]+(?:_[a-z0-9]+)+>|# Files mentioned by the user:)/i
const MAX_TRANSLATED_BYTES = 64 * 1024 * 1024

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonObject | JsonValue[]

interface JsonObject {
  [key: string]: JsonValue | undefined
}

interface CodexRolloutBase {
  at?: string
}

interface CodexSessionMeta extends CodexRolloutBase {
  kind: "session_meta"
  id: string
  cwd?: string
  startedAt?: string
}

interface CodexTurnContext extends CodexRolloutBase {
  kind: "turn_context"
  model?: string
}

interface CodexUserMessageEvent extends CodexRolloutBase {
  kind: "user_message_event"
  text: string
}

interface CodexTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface CodexTokenCountEvent extends CodexRolloutBase {
  kind: "token_count_event"
  usage?: CodexTokenUsage
}

interface CodexUserResponse extends CodexRolloutBase {
  kind: "user_response"
  text: string
}

interface CodexAssistantResponse extends CodexRolloutBase {
  kind: "assistant_response"
  text: string
}

interface CodexPlumbingResponse extends CodexRolloutBase {
  kind: "plumbing_response"
}

interface CodexReasoningResponse extends CodexRolloutBase {
  kind: "reasoning_response"
  text: string
}

interface CodexFunctionCallResponse extends CodexRolloutBase {
  kind: "function_call_response"
  callId?: string
  name: string
  input?: string
}

interface CodexFunctionOutputResponse extends CodexRolloutBase {
  kind: "function_output_response"
  callId?: string
  output: string
}

interface CodexIgnoredRolloutLine extends CodexRolloutBase {
  kind: "ignored"
}

type CodexRolloutEvent =
  | CodexSessionMeta
  | CodexTurnContext
  | CodexUserMessageEvent
  | CodexTokenCountEvent
  | CodexUserResponse
  | CodexAssistantResponse
  | CodexPlumbingResponse
  | CodexReasoningResponse
  | CodexFunctionCallResponse
  | CodexFunctionOutputResponse
  | CodexIgnoredRolloutLine

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>
type ToolBlock = EntryBlock & { type: "tool" }

interface CodexTranslator extends LineTranslator {
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

function textOf(content: JsonValue | undefined): string {
  if (isString(content)) return content
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const value of content) {
    const part = objectValue(value)
    text += stringValue(part?.["text"]) ?? ""
  }
  return text
}

function outputText(output: JsonValue | undefined): string {
  if (isString(output)) return output
  const content = stringValue(objectValue(output)?.["content"])
  return content ?? JSON.stringify(output ?? "") ?? ""
}

function parseTokenUsage(payload: JsonObject): CodexTokenUsage | undefined {
  const info = objectValue(payload["info"])
  const usage = objectValue(info?.["last_token_usage"])
  if (!usage) return undefined
  return {
    input: Number(usage["input_tokens"] ?? 0),
    output: Number(usage["output_tokens"] ?? 0),
    cacheRead: Number(usage["cached_input_tokens"] ?? 0),
    cacheWrite: Number(usage["cache_write_input_tokens"] ?? 0),
  }
}

function parseResponseItem(
  payload: JsonObject,
  at: string | undefined
): CodexRolloutEvent {
  switch (stringValue(payload["type"])) {
    case "message": {
      const text = textOf(payload["content"])
      switch (stringValue(payload["role"])) {
        case "user":
          return { kind: "user_response", at, text }
        case "assistant":
          return { kind: "assistant_response", at, text }
        default:
          return { kind: "plumbing_response", at }
      }
    }
    case "reasoning":
      return {
        kind: "reasoning_response",
        at,
        text: textOf(payload["summary"]) || textOf(payload["content"]),
      }
    case "function_call":
      return {
        kind: "function_call_response",
        at,
        callId: stringValue(payload["call_id"]),
        name: String(payload["name"] ?? "tool"),
        input: stringValue(payload["arguments"]),
      }
    case "function_call_output":
      return {
        kind: "function_output_response",
        at,
        callId: stringValue(payload["call_id"]),
        output: outputText(payload["output"]),
      }
    default:
      return { kind: "ignored", at }
  }
}

function parseCodexRolloutLine(raw: string): CodexRolloutEvent | null {
  const root = parseLine(raw)
  if (!root) return null
  const at = stringValue(root["timestamp"])
  const payload = objectValue(root["payload"])
  switch (stringValue(root["type"])) {
    case "session_meta":
      return {
        kind: "session_meta",
        at,
        id: String(payload?.["id"] ?? payload?.["session_id"] ?? ""),
        cwd: stringValue(payload?.["cwd"]),
        startedAt: stringValue(payload?.["timestamp"]),
      }
    case "turn_context":
      return {
        kind: "turn_context",
        at,
        model: stringValue(payload?.["model"]),
      }
    case "event_msg":
      if (!payload) return { kind: "ignored", at }
      switch (stringValue(payload["type"])) {
        case "user_message":
          return {
            kind: "user_message_event",
            at,
            text: String(payload["message"] ?? ""),
          }
        case "token_count":
          return {
            kind: "token_count_event",
            at,
            usage: parseTokenUsage(payload),
          }
        default:
          return { kind: "ignored", at }
      }
    case "response_item":
      return payload ? parseResponseItem(payload, at) : { kind: "ignored", at }
    case undefined:
      return null
    default:
      return { kind: "ignored", at }
  }
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
      const event = parseCodexRolloutLine(raw)
      if (!event) return spent < budget
      if (event.kind === "session_meta") {
        sawMeta = true
        if (!event.id) return false
        ref = {
          harness: this.harness,
          nativeId: event.id,
          path: file.path,
          cwd: event.cwd,
          startedAt: event.startedAt ?? event.at,
          updatedAt: new Date(file.mtimeMs).toISOString(),
          bytes: file.bytes,
        }
        return spent < budget
      }
      if (!sawMeta) return false // Not a rollout file at all.
      if (!ref) return spent < budget
      if (event.kind === "turn_context" && !ref.model && event.model) {
        ref.model = event.model
      }
      if (
        !ref.title &&
        (event.kind === "user_message_event" ||
          event.kind === "user_response") &&
        !INJECTED.test(event.text.trimStart())
      ) {
        ref.title = titleFrom(event.text)
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
    const fromByte = Math.max(0, file.size - MAX_TRANSLATED_BYTES)
    await readLines(path, fromByte, into.push)
    const entries = into.done()
    if (fromByte > 0) {
      entries.unshift({
        kind: "event",
        label: "Earlier history not shown",
        detail: `The most recent ${MAX_TRANSLATED_BYTES / 1024 / 1024} MB is shown; earlier history remains in the native session file`,
      })
    }
    return { ref, entries }
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

/**
 * Turn raw rollout lines into canonical entries, one line at a time.
 *
 * Function calls and their outputs are paired by `call_id` and merged into a
 * single tool block on the current assistant turn. A `token_count` event
 * closes over the most recent assistant entry, which is the turn it priced.
 * Push-based so a gigabyte session streams through without ever being held.
 */
function translator(): CodexTranslator {
  const sink = new EntrySink()
  let assistant: AssistantEntry | null = null
  const callsById = new Map<string, ToolBlock>()
  let started = false
  let needsReset = false
  let model: string | undefined

  const openAssistant = (at?: string): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", at, model, blocks: [] }
      sink.push(assistant)
    }
    return assistant
  }

  const push = (raw: string): void => {
    const event = parseCodexRolloutLine(raw)
    if (!event) return

    switch (event.kind) {
      case "turn_context":
        if (event.model) model = event.model
        return
      case "token_count_event":
        if (event.usage && assistant) {
          const usage: TurnUsage = {
            input: event.usage.input,
            output: event.usage.output,
            cacheRead: event.usage.cacheRead,
            cacheWrite: event.usage.cacheWrite,
          }
          assistant.usage = usage
        }
        return
      case "user_response":
        if (INJECTED.test(event.text.trimStart()) || !event.text.trim()) return
        assistant = null
        started = true
        sink.push({ kind: "user", at: event.at, text: event.text })
        return
      case "assistant_response":
        if (!event.text) return
        if (!started) needsReset = true
        started = true
        openAssistant(event.at).blocks.push({ type: "text", text: event.text })
        return
      case "reasoning_response":
        if (!event.text.trim()) return
        if (!started) needsReset = true
        started = true
        openAssistant(event.at).blocks.push({
          type: "thinking",
          text: event.text,
        })
        return
      case "function_call_response": {
        if (!started) needsReset = true
        started = true
        const block: ToolBlock = {
          type: "tool",
          name: event.name,
          input: clip(event.input),
        }
        if (event.callId) callsById.set(event.callId, block)
        openAssistant(event.at).blocks.push(block)
        return
      }
      case "function_output_response": {
        const id = event.callId ?? ""
        const block = callsById.get(id)
        if (block) {
          block.output = clip(event.output)
          callsById.delete(id)
        } else if (id) {
          needsReset = true
        }
        return
      }
      case "session_meta":
      case "user_message_event":
      case "plumbing_response":
      case "ignored":
        return
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
