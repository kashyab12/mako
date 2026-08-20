import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { StringDecoder } from "node:string_decoder"
import type { JsonObject, JsonRpcId, JsonValue } from "./codex-app-json.js"
import type { AcpSessionState, AcpUpdate } from "./shared.js"

export type Tuning = {
  model?: string
  effort?: string
  fast?: boolean
  options?: Record<string, string | boolean>
}

type UserMessageContent = { type?: string; text?: string }
type FileChange = { path?: string; diff?: string; kind?: JsonValue }
type McpToolError = { message?: string }

export type ThreadItem =
  | {
      type: "userMessage"
      id: string
      content: UserMessageContent[]
    }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution"
      id: string
      command: string
      cwd: string
      status: string
      aggregatedOutput: string | null
      exitCode: number | null
    }
  | {
      type: "fileChange"
      id: string
      changes: FileChange[]
      status: string
    }
  | {
      type: "mcpToolCall"
      id: string
      server: string
      tool: string
      status: string
      result: JsonValue
      error: McpToolError | null
    }
  | {
      type: "dynamicToolCall"
      id: string
      namespace: string | null
      tool: string
      status: string
      contentItems: JsonValue[] | null
      success: boolean | null
    }
  | { type: "plan"; id: string; text: string }
  | { type: "unsupported"; id: string; sourceType: string }

export type Turn = {
  id: string
  items: ThreadItem[]
  status: string
  error: { message?: string; additionalDetails?: string | null } | null
}

export type ThreadResponse = {
  thread: { id: string; cwd?: string; turns?: Turn[] }
  model?: string
  serviceTier?: string | null
  reasoningEffort?: string | null
}

export type RpcParams = {
  initialize: {
    clientInfo: { name: string; title: string; version: string }
    capabilities: { experimentalApi: true; requestAttestation: false }
  }
  "thread/start": {
    cwd: string
    model?: string
    serviceTier?: string
    config?: JsonObject
  }
  "thread/resume": {
    threadId: string
    cwd: string
    model?: string
    serviceTier?: string
    config?: JsonObject
  }
  "turn/start": {
    threadId: string
    input: Array<
      | { type: "text"; text: string; textElements?: JsonValue[] }
      | { type: "localImage"; path: string }
    >
    cwd: string
    model?: string
    effort?: string
    serviceTier?: string
  }
  "turn/interrupt": { threadId: string; turnId: string }
}

export type RpcResults = {
  initialize: JsonObject
  "thread/start": ThreadResponse
  "thread/resume": ThreadResponse
  "turn/start": { turn: Turn }
  "turn/interrupt": JsonObject
}

export type RpcMethod = keyof RpcParams

export type ParseResult<T> =
  { valid: true; value: T } | { valid: false; message: string }

export type RpcResultParser<M extends RpcMethod> = (
  value: JsonValue | undefined
) => ParseResult<RpcResults[M]>

export type PendingRpc<M extends RpcMethod = RpcMethod> = {
  method: M
  resolve(value: RpcResults[M]): void
  reject(error: Error): void
  parseResult: RpcResultParser<M>
  settleResult(value: JsonValue | undefined): void
  timer: ReturnType<typeof setTimeout>
}

export type ItemTracker = {
  acpId: string
  started: boolean
  textDelta: boolean
  text: string | null
  thinkingDelta: boolean
  thinking: string | null
  output: string
}

export interface ProtocolCallbacks {
  handleFatal(message: string): void
  updateState(patch: Partial<AcpSessionState>): void
  emitUpdate(update: AcpUpdate): void
  handleServerRequest(id: JsonRpcId, method: string, params: JsonObject): void
  resolveServerRequest(id: JsonRpcId): void
  clearTurnServerRequests(turnId: string): void
}

export interface ProtocolContext {
  child: ChildProcessWithoutNullStreams
  threadId: string | null
  currentTurnId: string | null
  state: AcpSessionState
  nextRequestId: number
  pending: Map<string, PendingRpc>
  items: Map<string, ItemTracker>
  stdoutBuffer: string
  decoder: StringDecoder
  exited: boolean
  protocol: ProtocolCallbacks
}
