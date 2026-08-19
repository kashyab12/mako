import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { StringDecoder } from "node:string_decoder"
import type { AcpSessionState, AcpUpdate } from "./shared.js"

export type JsonRpcId = string | number
export type JsonScalar = boolean | number | string | null
export type JsonValue = JsonScalar | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

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

type ParseResult<T> =
  { valid: true; value: T } | { valid: false; message: string }

type RpcResultParser<M extends RpcMethod> = (
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

type JsonRpcEnvelope =
  | {
      kind: "response"
      id: JsonRpcId
      result: JsonValue | undefined
      error: JsonObject | null
    }
  | { kind: "request"; id: JsonRpcId; method: string; params: JsonObject }
  | { kind: "notification"; method: string; params: JsonObject }
  | { kind: "ignored" }
  | { kind: "invalid" }

type StartedTurnNotification = {
  method: "turn/started"
  threadId: string
  turnId: string
}

type CompletedTurnNotification = {
  method: "turn/completed"
  threadId: string
  turn: Turn
}

type ItemNotification = {
  method: "item/started" | "item/completed"
  threadId: string
  turnId: string
  item: ThreadItem
}

type StreamDeltaNotification = {
  method:
    | "item/agentMessage/delta"
    | "item/reasoning/summaryTextDelta"
    | "item/reasoning/textDelta"
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

type ToolOutputNotification = {
  method:
    | "item/commandExecution/outputDelta"
    | "item/fileChange/outputDelta"
    | "item/mcpToolCall/progress"
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

type PatchNotification = {
  method: "item/fileChange/patchUpdated"
  threadId: string
  turnId: string
  itemId: string
  changes: JsonValue
}

type PlanNotification = {
  method: "turn/plan/updated"
  threadId: string
  plan: Array<{ step: string; status: string }>
}

type ErrorNotification = {
  method: "error"
  threadId?: string
  message: string
}

type ResolvedNotification = {
  method: "serverRequest/resolved"
  threadId?: string
  requestId: JsonRpcId
}

type TokenUsageNotification = {
  method: "thread/tokenUsage/updated"
  threadId: string
}

type ProtocolNotification =
  | StartedTurnNotification
  | CompletedTurnNotification
  | ItemNotification
  | StreamDeltaNotification
  | ToolOutputNotification
  | PatchNotification
  | PlanNotification
  | ErrorNotification
  | ResolvedNotification
  | TokenUsageNotification

const RPC_TIMEOUT_MS = 30_000
const MAX_STDOUT_BUFFER = 8 * 1024 * 1024
const MAX_TOOL_OUTPUT = 32 * 1024
const MAX_STREAM_COMPARE = 128 * 1024
const MAX_TRACKED_ITEMS = 2048
const MAX_REPLAY_ITEMS = 1000

export function consumeStdout(context: ProtocolContext, chunk: Buffer): void {
  if (context.exited) return
  context.stdoutBuffer += context.decoder.write(chunk)
  if (Buffer.byteLength(context.stdoutBuffer, "utf8") > MAX_STDOUT_BUFFER) {
    context.protocol.handleFatal(
      "Codex app-server sent an oversized JSON-RPC message"
    )
    return
  }
  let newline = context.stdoutBuffer.indexOf("\n")
  while (newline >= 0) {
    const line = context.stdoutBuffer.slice(0, newline).replace(/\r$/, "")
    context.stdoutBuffer = context.stdoutBuffer.slice(newline + 1)
    if (line.trim()) processLine(context, line)
    if (context.exited) return
    newline = context.stdoutBuffer.indexOf("\n")
  }
}

function processLine(context: ProtocolContext, line: string): void {
  const message = parseJsonRpcEnvelope(line)
  if (message.kind === "invalid") {
    context.protocol.handleFatal("Codex app-server sent invalid JSON-RPC")
    return
  }
  if (message.kind === "ignored") return
  if (message.kind === "response") {
    settleRpc(context, message)
    return
  }
  if (message.kind === "request") {
    context.protocol.handleServerRequest(
      message.id,
      message.method,
      message.params
    )
    return
  }
  const notification = parseNotification(message.method, message.params)
  if (notification) handleNotification(context, notification)
}

function parseJsonRpcEnvelope(line: string): JsonRpcEnvelope {
  let value: JsonValue
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: "invalid" }
  }
  if (!isJsonObject(value)) return { kind: "ignored" }
  const id = rpcIdValue(value.id)
  if (
    id !== undefined &&
    (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))
  ) {
    return {
      kind: "response",
      id,
      result: value.result,
      error: isJsonObject(value.error) ? value.error : null,
    }
  }
  const method = stringValue(value.method)
  if (method === undefined) return { kind: "ignored" }
  const params = isJsonObject(value.params) ? value.params : {}
  return id === undefined
    ? { kind: "notification", method, params }
    : { kind: "request", id, method, params }
}

function settleRpc(
  context: ProtocolContext,
  message: Extract<JsonRpcEnvelope, { kind: "response" }>
): void {
  const key = rpcKey(message.id)
  const pending = context.pending.get(key)
  if (!pending) return
  context.pending.delete(key)
  clearTimeout(pending.timer)
  if (message.error) {
    pending.reject(
      new Error(
        stringValue(message.error.message) ?? "Codex JSON-RPC request failed"
      )
    )
    return
  }
  pending.settleResult(message.result)
}

function parseNotification(
  method: string,
  params: JsonObject
): ProtocolNotification | null {
  const threadId = stringValue(params.threadId)
  switch (method) {
    case "turn/started": {
      const turn = objectValue(params.turn)
      const turnId = stringValue(turn?.id)
      return threadId !== undefined && turnId !== undefined
        ? { method, threadId, turnId }
        : null
    }
    case "turn/completed": {
      const turn = parseTurn(params.turn)
      return threadId !== undefined && turn ? { method, threadId, turn } : null
    }
    case "item/started":
    case "item/completed": {
      const turnId = stringValue(params.turnId)
      const item = parseThreadItem(params.item)
      return threadId !== undefined && turnId !== undefined && item
        ? { method, threadId, turnId, item }
        : null
    }
    case "item/agentMessage/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        delta !== undefined
        ? { method, threadId, turnId, itemId, delta }
        : null
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        delta !== undefined
        ? { method, threadId, turnId, itemId, delta }
        : null
    }
    case "item/mcpToolCall/progress": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      const message = stringValue(params.message)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        message !== undefined
        ? { method, threadId, turnId, itemId, delta: `${message}\n` }
        : null
    }
    case "item/fileChange/patchUpdated": {
      const turnId = stringValue(params.turnId)
      const itemId = stringValue(params.itemId)
      return threadId !== undefined &&
        turnId !== undefined &&
        itemId !== undefined &&
        params.changes !== undefined
        ? { method, threadId, turnId, itemId, changes: params.changes }
        : null
    }
    case "turn/plan/updated": {
      const plan = parsePlan(params.plan)
      return threadId !== undefined && plan ? { method, threadId, plan } : null
    }
    case "error": {
      const error = objectValue(params.error)
      return {
        method,
        threadId,
        message: stringValue(error?.message) ?? "Codex encountered an error",
      }
    }
    case "serverRequest/resolved": {
      const requestId = rpcIdValue(params.requestId)
      return requestId === undefined ? null : { method, threadId, requestId }
    }
    case "thread/tokenUsage/updated":
      return threadId === undefined ? null : { method, threadId }
    default:
      return null
  }
}

function handleNotification(
  context: ProtocolContext,
  notification: ProtocolNotification
): void {
  if (
    notification.threadId &&
    context.threadId &&
    notification.threadId !== context.threadId
  )
    return
  switch (notification.method) {
    case "turn/started":
      context.currentTurnId = notification.turnId
      if (context.state.status !== "running")
        context.protocol.updateState({ status: "running", error: undefined })
      return
    case "turn/completed":
      completeTurn(context, notification.turn)
      return
    case "item/started":
      handleItem(context, notification.turnId, notification.item, false)
      return
    case "item/completed":
      handleItem(context, notification.turnId, notification.item, true)
      return
    case "item/agentMessage/delta":
      streamDelta(context, notification, "text")
      return
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      streamDelta(context, notification, "thinking")
      return
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/mcpToolCall/progress":
      streamToolOutput(context, notification)
      return
    case "item/fileChange/patchUpdated":
      updateToolOutput(context, notification, boundedJson(notification.changes))
      return
    case "turn/plan/updated":
      context.protocol.emitUpdate({
        kind: "plan",
        entries: notification.plan.map((step) => ({
          content: step.step,
          status: step.status === "inProgress" ? "in_progress" : step.status,
        })),
      })
      return
    case "error":
      context.protocol.updateState({ error: notification.message })
      return
    case "serverRequest/resolved":
      context.protocol.resolveServerRequest(notification.requestId)
      return
    case "thread/tokenUsage/updated":
      return
  }
}

function completeTurn(context: ProtocolContext, turn: Turn): void {
  const error = turn.error?.message || undefined
  const stop = turn.status === "inProgress" ? "completed" : turn.status
  context.currentTurnId = null
  context.protocol.clearTurnServerRequests(turn.id)
  for (const key of context.items.keys()) {
    if (key.startsWith(`${turn.id}\u0000`)) context.items.delete(key)
  }
  context.protocol.updateState({ status: "ready", lastStop: stop, error })
}

function streamDelta(
  context: ProtocolContext,
  notification: StreamDeltaNotification,
  kind: "text" | "thinking"
): void {
  if (!notification.turnId || !notification.itemId || !notification.delta)
    return
  const tracker = itemTracker(context, notification.turnId, notification.itemId)
  if (kind === "text") {
    tracker.textDelta = true
    tracker.text = appendComparable(tracker.text, notification.delta)
  } else {
    tracker.thinkingDelta = true
    tracker.thinking = appendComparable(tracker.thinking, notification.delta)
  }
  context.protocol.emitUpdate({ kind, text: notification.delta })
}

function streamToolOutput(
  context: ProtocolContext,
  notification: ToolOutputNotification
): void {
  if (!notification.delta || !notification.turnId || !notification.itemId)
    return
  const tracker = itemTracker(context, notification.turnId, notification.itemId)
  tracker.output = tail(tracker.output + notification.delta, MAX_TOOL_OUTPUT)
  context.protocol.emitUpdate({
    kind: "tool-update",
    id: tracker.acpId,
    output: tracker.output,
  })
}

function updateToolOutput(
  context: ProtocolContext,
  notification: PatchNotification,
  output: string
): void {
  if (!notification.turnId || !notification.itemId) return
  const tracker = itemTracker(context, notification.turnId, notification.itemId)
  tracker.output = boundedText(output, MAX_TOOL_OUTPUT)
  context.protocol.emitUpdate({
    kind: "tool-update",
    id: tracker.acpId,
    output: tracker.output,
  })
}

function handleItem(
  context: ProtocolContext,
  turnId: string,
  item: ThreadItem,
  completed: boolean,
  replay = false
): void {
  if (!turnId) return
  const tracker = itemTracker(context, turnId, item.id)
  switch (item.type) {
    case "userMessage":
      if (completed && replay) {
        const text = item.content
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("\n")
        if (text) context.protocol.emitUpdate({ kind: "user", text })
      }
      return
    case "agentMessage":
      if (completed)
        emitFinalText(
          context,
          "text",
          item.text,
          tracker.textDelta,
          tracker.text
        )
      return
    case "reasoning":
      if (completed) {
        const final = [...item.summary, ...item.content]
          .filter(Boolean)
          .join("\n\n")
        emitFinalText(
          context,
          "thinking",
          final,
          tracker.thinkingDelta,
          tracker.thinking
        )
      }
      return
    case "commandExecution":
      startTool(
        context,
        tracker,
        item.command || "Command",
        "execute",
        item.status
      )
      if (completed) {
        const output = item.aggregatedOutput ?? tracker.output
        finishTool(context, tracker, item.status, output || undefined)
      }
      return
    case "fileChange": {
      const paths = item.changes.flatMap((change) =>
        change.path === undefined ? [] : [change.path]
      )
      startTool(
        context,
        tracker,
        paths.length ? `Edit ${paths.join(", ")}` : "File changes",
        "edit",
        item.status
      )
      if (completed)
        finishTool(context, tracker, item.status, boundedJson(item.changes))
      return
    }
    case "mcpToolCall":
      startTool(
        context,
        tracker,
        `${item.server}: ${item.tool}`,
        "fetch",
        item.status
      )
      if (completed) {
        const output =
          item.error?.message ||
          (item.result === null ? tracker.output : boundedJson(item.result))
        finishTool(context, tracker, item.status, output || undefined)
      }
      return
    case "dynamicToolCall":
      startTool(
        context,
        tracker,
        `${item.namespace ? `${item.namespace}.` : ""}${item.tool}`,
        "other",
        item.status
      )
      if (completed)
        finishTool(
          context,
          tracker,
          item.status,
          item.contentItems ? boundedJson(item.contentItems) : undefined
        )
      return
    case "plan":
      return
  }
}

function startTool(
  context: ProtocolContext,
  tracker: ItemTracker,
  title: string,
  toolKind: string,
  status: string
): void {
  if (tracker.started) return
  tracker.started = true
  context.protocol.emitUpdate({
    kind: "tool",
    id: tracker.acpId,
    title: boundedText(title, 500),
    toolKind,
    status: toolStatus(status),
  })
}

function finishTool(
  context: ProtocolContext,
  tracker: ItemTracker,
  status: string,
  output?: string
): void {
  context.protocol.emitUpdate({
    kind: "tool-update",
    id: tracker.acpId,
    status: toolStatus(status),
    output: output ? boundedText(output, MAX_TOOL_OUTPUT) : undefined,
  })
}

function emitFinalText(
  context: ProtocolContext,
  kind: "text" | "thinking",
  final: string,
  hadDelta: boolean,
  streamed: string | null
): void {
  if (!final) return
  if (!hadDelta) {
    emitTextChunks(context, kind, final)
    return
  }
  if (
    streamed !== null &&
    final.startsWith(streamed) &&
    final.length > streamed.length
  ) {
    emitTextChunks(context, kind, final.slice(streamed.length))
  }
}

function emitTextChunks(
  context: ProtocolContext,
  kind: "text" | "thinking",
  text: string
): void {
  for (let offset = 0; offset < text.length; offset += MAX_TOOL_OUTPUT) {
    context.protocol.emitUpdate({
      kind,
      text: text.slice(offset, offset + MAX_TOOL_OUTPUT),
    })
  }
}

function itemTracker(
  context: ProtocolContext,
  turnId: string,
  itemId: string
): ItemTracker {
  const key = `${turnId}\u0000${itemId}`
  const current = context.items.get(key)
  if (current) return current
  if (context.items.size >= MAX_TRACKED_ITEMS) {
    const oldest = context.items.keys().next().value
    if (oldest !== undefined) context.items.delete(oldest)
  }
  const tracker: ItemTracker = {
    acpId: `codex:${turnId}:${itemId}`,
    started: false,
    textDelta: false,
    text: "",
    thinkingDelta: false,
    thinking: "",
    output: "",
  }
  context.items.set(key, tracker)
  return tracker
}

export function replayHistory(context: ProtocolContext, turns: Turn[]): void {
  const entries = turns.flatMap((turn) =>
    turn.items.map((item) => ({ turnId: turn.id, item }))
  )
  for (const entry of entries.slice(-MAX_REPLAY_ITEMS))
    handleItem(context, entry.turnId, entry.item, true, true)
  context.items.clear()
}

export function rpcRequest<M extends RpcMethod>(
  context: ProtocolContext,
  method: M,
  params: RpcParams[M]
): Promise<RpcResults[M]>
export function rpcRequest(
  context: ProtocolContext,
  method: RpcMethod,
  params: RpcParams[RpcMethod]
): Promise<RpcResults[RpcMethod]> {
  switch (method) {
    case "initialize":
      return beginRpcRequest(context, method, params, parseObjectResult)
    case "thread/start":
    case "thread/resume":
      return beginRpcRequest(context, method, params, parseThreadResponse)
    case "turn/start":
      return beginRpcRequest(context, method, params, parseTurnResponse)
    case "turn/interrupt":
      return beginRpcRequest(context, method, params, parseObjectResult)
  }
}

function beginRpcRequest<M extends RpcMethod>(
  context: ProtocolContext,
  method: M,
  params: JsonObject,
  parseResult: RpcResultParser<M>
): Promise<RpcResults[M]> {
  if (context.exited || context.child.stdin.destroyed)
    return Promise.reject(new Error("Codex app-server is not running"))
  const id = ++context.nextRequestId
  return new Promise<RpcResults[M]>((resolve, reject) => {
    const timer = setTimeout(() => {
      context.pending.delete(rpcKey(id))
      reject(new Error(`Codex app-server did not answer ${method}`))
    }, RPC_TIMEOUT_MS)
    const pending: PendingRpc<M> = {
      method,
      resolve,
      reject,
      parseResult,
      settleResult: (value) => {
        const parsed = parseResult(value)
        if (parsed.valid) resolve(parsed.value)
        else reject(new Error(parsed.message))
      },
      timer,
    }
    context.pending.set(rpcKey(id), pending)
    if (!sendRpc(context, { jsonrpc: "2.0", id, method, params })) {
      clearTimeout(timer)
      context.pending.delete(rpcKey(id))
      reject(new Error("Failed to write to Codex app-server"))
    }
  })
}

export function sendRpc(
  context: ProtocolContext,
  message: JsonObject
): boolean {
  if (
    context.exited ||
    context.child.stdin.destroyed ||
    !context.child.stdin.writable
  )
    return false
  try {
    context.child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  } catch {
    return false
  }
}

export function sendRpcResult(
  context: ProtocolContext,
  id: JsonRpcId,
  result: JsonValue
): void {
  sendRpc(context, { jsonrpc: "2.0", id, result })
}

export function sendRpcError(
  context: ProtocolContext,
  id: JsonRpcId,
  code: number,
  message: string
): void {
  sendRpc(context, { jsonrpc: "2.0", id, error: { code, message } })
}

function parseObjectResult(
  value: JsonValue | undefined
): ParseResult<JsonObject> {
  return isJsonObject(value)
    ? { valid: true, value }
    : invalidResult("Codex app-server returned an invalid object result")
}

function parseThreadResponse(
  value: JsonValue | undefined
): ParseResult<ThreadResponse> {
  const root = objectValue(value)
  const thread = objectValue(root?.thread)
  const id = stringValue(thread?.id)
  if (!root || !thread || id === undefined)
    return invalidResult("Codex app-server returned an invalid thread result")
  const cwd = optionalString(thread.cwd)
  if (!cwd.valid)
    return invalidResult("Codex app-server returned an invalid thread cwd")
  const turns = optionalArray(thread.turns, parseTurn)
  if (!turns.valid)
    return invalidResult("Codex app-server returned invalid thread turns")
  const model = optionalString(root.model)
  const serviceTier = optionalNullableString(root.serviceTier)
  const reasoningEffort = optionalNullableString(root.reasoningEffort)
  if (!model.valid || !serviceTier.valid || !reasoningEffort.valid)
    return invalidResult("Codex app-server returned invalid thread metadata")
  const parsedThread: ThreadResponse["thread"] = { id }
  if (cwd.value !== undefined) parsedThread.cwd = cwd.value
  if (turns.value !== undefined) parsedThread.turns = turns.value
  const response: ThreadResponse = { thread: parsedThread }
  if (model.value !== undefined) response.model = model.value
  if (serviceTier.value !== undefined) response.serviceTier = serviceTier.value
  if (reasoningEffort.value !== undefined)
    response.reasoningEffort = reasoningEffort.value
  return { valid: true, value: response }
}

function parseTurnResponse(
  value: JsonValue | undefined
): ParseResult<{ turn: Turn }> {
  const root = objectValue(value)
  const turn = parseTurn(root?.turn)
  return root && turn
    ? { valid: true, value: { turn } }
    : invalidResult("Codex app-server returned an invalid turn result")
}

function parseTurn(value: JsonValue | undefined): Turn | null {
  const root = objectValue(value)
  const id = stringValue(root?.id)
  const status = stringValue(root?.status)
  const items = parseArray(root?.items, parseThreadItem)
  const error = parseTurnError(root?.error)
  return root &&
    id !== undefined &&
    status !== undefined &&
    items &&
    error.valid
    ? { id, status, items, error: error.value }
    : null
}

function parseTurnError(
  value: JsonValue | undefined
): ParseResult<Turn["error"]> {
  if (value === null) return { valid: true, value: null }
  const root = objectValue(value)
  if (!root) return invalidResult("invalid turn error")
  const message = optionalString(root.message)
  const additionalDetails = optionalNullableString(root.additionalDetails)
  if (!message.valid || !additionalDetails.valid)
    return invalidResult("invalid turn error")
  const error: Exclude<Turn["error"], null> = {}
  if (message.value !== undefined) error.message = message.value
  if (additionalDetails.value !== undefined)
    error.additionalDetails = additionalDetails.value
  return { valid: true, value: error }
}

function parseThreadItem(value: JsonValue | undefined): ThreadItem | null {
  const root = objectValue(value)
  const type = stringValue(root?.type)
  const id = stringValue(root?.id)
  if (!root || type === undefined || id === undefined) return null
  switch (type) {
    case "userMessage": {
      const content = parseArray(root.content, parseUserContent)
      return content ? { type, id, content } : null
    }
    case "agentMessage": {
      const text = stringValue(root.text)
      return text === undefined ? null : { type, id, text }
    }
    case "reasoning": {
      const summary = stringArray(root.summary)
      const content = stringArray(root.content)
      return summary && content ? { type, id, summary, content } : null
    }
    case "commandExecution": {
      const command = stringValue(root.command)
      const cwd = stringValue(root.cwd)
      const status = stringValue(root.status)
      const aggregatedOutput = nullableString(root.aggregatedOutput)
      const exitCode = nullableNumber(root.exitCode)
      return command !== undefined &&
        cwd !== undefined &&
        status !== undefined &&
        aggregatedOutput.valid &&
        exitCode.valid
        ? {
            type,
            id,
            command,
            cwd,
            status,
            aggregatedOutput: aggregatedOutput.value,
            exitCode: exitCode.value,
          }
        : null
    }
    case "fileChange": {
      const changes = parseArray(root.changes, parseFileChange)
      const status = stringValue(root.status)
      return changes && status !== undefined
        ? { type, id, changes, status }
        : null
    }
    case "mcpToolCall": {
      const server = stringValue(root.server)
      const tool = stringValue(root.tool)
      const status = stringValue(root.status)
      const error = parseItemError(root.error)
      return server !== undefined &&
        tool !== undefined &&
        status !== undefined &&
        root.result !== undefined &&
        error.valid
        ? {
            type,
            id,
            server,
            tool,
            status,
            result: root.result,
            error: error.value,
          }
        : null
    }
    case "dynamicToolCall": {
      const namespace = nullableString(root.namespace)
      const tool = stringValue(root.tool)
      const status = stringValue(root.status)
      const contentItems = nullableJsonArray(root.contentItems)
      const success = nullableBoolean(root.success)
      return namespace.valid &&
        tool !== undefined &&
        status !== undefined &&
        contentItems.valid &&
        success.valid
        ? {
            type,
            id,
            namespace: namespace.value,
            tool,
            status,
            contentItems: contentItems.value,
            success: success.value,
          }
        : null
    }
    case "plan": {
      const text = stringValue(root.text)
      return text === undefined ? null : { type, id, text }
    }
    default:
      return null
  }
}

function parseUserContent(value: JsonValue): UserMessageContent | null {
  const root = objectValue(value)
  if (!root) return null
  const type = optionalString(root.type)
  const text = optionalString(root.text)
  if (!type.valid || !text.valid) return null
  const content: UserMessageContent = {}
  if (type.value !== undefined) content.type = type.value
  if (text.value !== undefined) content.text = text.value
  return content
}

function parseFileChange(value: JsonValue): FileChange | null {
  const root = objectValue(value)
  if (!root) return null
  const path = optionalString(root.path)
  const diff = optionalString(root.diff)
  if (!path.valid || !diff.valid) return null
  const change: FileChange = {}
  if (path.value !== undefined) change.path = path.value
  if (diff.value !== undefined) change.diff = diff.value
  if (root.kind !== undefined) change.kind = root.kind
  return change
}

function parseItemError(
  value: JsonValue | undefined
): ParseResult<McpToolError | null> {
  if (value === null) return { valid: true, value: null }
  const root = objectValue(value)
  const message = optionalString(root?.message)
  if (!root || !message.valid) return invalidResult("invalid item error")
  const error: McpToolError = {}
  if (message.value !== undefined) error.message = message.value
  return { valid: true, value: error }
}

function parsePlan(
  value: JsonValue | undefined
): Array<{ step: string; status: string }> | null {
  return parseArray(value, (entry) => {
    const root = objectValue(entry)
    const step = stringValue(root?.step)
    const status = stringValue(root?.status)
    return root && step !== undefined && status !== undefined
      ? { step, status }
      : null
  })
}

function invalidResult<T>(message: string): ParseResult<T> {
  return { valid: false, message }
}

function parseArray<T>(
  value: JsonValue | undefined,
  parse: (entry: JsonValue) => T | null
): T[] | null {
  if (!Array.isArray(value)) return null
  const result: T[] = []
  for (const entry of value) {
    const parsed = parse(entry)
    if (parsed === null) return null
    result.push(parsed)
  }
  return result
}

function optionalArray<T>(
  value: JsonValue | undefined,
  parse: (entry: JsonValue) => T | null
): ParseResult<T[] | undefined> {
  if (value === undefined) return { valid: true, value: undefined }
  const parsed = parseArray(value, parse)
  return parsed
    ? { valid: true, value: parsed }
    : invalidResult("invalid array")
}

function stringArray(value: JsonValue | undefined): string[] | null {
  return parseArray(value, (entry) => stringValue(entry) ?? null)
}

function optionalString(
  value: JsonValue | undefined
): ParseResult<string | undefined> {
  if (value === undefined) return { valid: true, value: undefined }
  const parsed = stringValue(value)
  return parsed === undefined
    ? invalidResult("invalid string")
    : { valid: true, value: parsed }
}

function optionalNullableString(
  value: JsonValue | undefined
): ParseResult<string | null | undefined> {
  if (value === undefined || value === null) return { valid: true, value }
  const parsed = stringValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable string")
    : { valid: true, value: parsed }
}

function nullableString(
  value: JsonValue | undefined
): ParseResult<string | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = stringValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable string")
    : { valid: true, value: parsed }
}

function nullableNumber(
  value: JsonValue | undefined
): ParseResult<number | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = numberValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable number")
    : { valid: true, value: parsed }
}

function nullableBoolean(
  value: JsonValue | undefined
): ParseResult<boolean | null> {
  if (value === null) return { valid: true, value: null }
  const parsed = booleanValue(value)
  return parsed === undefined
    ? invalidResult("invalid nullable boolean")
    : { valid: true, value: parsed }
}

function nullableJsonArray(
  value: JsonValue | undefined
): ParseResult<JsonValue[] | null> {
  if (value === null) return { valid: true, value: null }
  return Array.isArray(value)
    ? { valid: true, value }
    : invalidResult("invalid nullable array")
}

function toolStatus(status: string): string {
  if (status === "inProgress" || status === "pending") return "pending"
  if (status === "completed") return "completed"
  return "failed"
}

function appendComparable(
  current: string | null,
  delta: string
): string | null {
  if (current === null || current.length + delta.length > MAX_STREAM_COMPARE)
    return null
  return current + delta
}

function boundedJson(value: JsonValue): string {
  try {
    return boundedText(JSON.stringify(value, null, 2), MAX_TOOL_OUTPUT)
  } catch {
    return "[unserializable output]"
  }
}

export function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const half = Math.floor((limit - 32) / 2)
  return `${value.slice(0, half)}\n… output truncated …\n${value.slice(-half)}`
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function rpcKey(id: JsonRpcId): string {
  return `${isNumber(id) ? "number" : "string"}:${id}`
}

function rpcIdValue(value: JsonValue | undefined): JsonRpcId | undefined {
  return stringValue(value) ?? numberValue(value)
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
  return isBoolean(value) ? value : undefined
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBoolean(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}
