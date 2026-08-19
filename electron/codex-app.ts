import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { StringDecoder } from "node:string_decoder"
import { accountEnv } from "./accounts.js"
import type {
  AcpPermissionRequest,
  AcpPromptAttachment,
  AcpSessionState,
  AcpUpdate,
  HostEvent,
} from "./shared.js"

type JsonRpcId = string | number
type JsonObject = Record<string, unknown>
type Tuning = {
  model?: string
  effort?: string
  fast?: boolean
  options?: Record<string, string | boolean>
}

type ThreadItem =
  | {
      type: "userMessage"
      id: string
      content: Array<{ type?: string; text?: string }>
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
      changes: Array<{ path?: string; diff?: string; kind?: unknown }>
      status: string
    }
  | {
      type: "mcpToolCall"
      id: string
      server: string
      tool: string
      status: string
      result: unknown
      error: { message?: string } | null
    }
  | {
      type: "dynamicToolCall"
      id: string
      namespace: string | null
      tool: string
      status: string
      contentItems: unknown[] | null
      success: boolean | null
    }
  | { type: "plan"; id: string; text: string }

type Turn = {
  id: string
  items: ThreadItem[]
  status: "completed" | "interrupted" | "failed" | "inProgress" | string
  error: { message?: string; additionalDetails?: string | null } | null
}

type ThreadResponse = {
  thread: { id: string; cwd?: string; turns?: Turn[] }
  model?: string
  serviceTier?: string | null
  reasoningEffort?: string | null
}

type RpcParams = {
  initialize: {
    clientInfo: { name: string; title: string; version: string }
    capabilities: { experimentalApi: true; requestAttestation: false }
  }
  "thread/start": {
    cwd: string
    model?: string
    serviceTier?: string
    config?: Record<string, unknown>
  }
  "thread/resume": {
    threadId: string
    cwd: string
    model?: string
    serviceTier?: string
    config?: Record<string, unknown>
  }
  "turn/start": {
    threadId: string
    input: Array<
      | { type: "text"; text: string; textElements?: unknown[] }
      | { type: "localImage"; path: string }
    >
    cwd: string
    model?: string
    effort?: string
    serviceTier?: string
  }
  "turn/interrupt": { threadId: string; turnId: string }
}

type RpcResults = {
  initialize: JsonObject
  "thread/start": ThreadResponse
  "thread/resume": ThreadResponse
  "turn/start": { turn: Turn }
  "turn/interrupt": JsonObject
}

type RpcMethod = keyof RpcParams
type PendingRpc = {
  [M in RpcMethod]: {
    method: M
    resolve: (value: RpcResults[M]) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
}[RpcMethod]

type CommandDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: unknown }
  | { applyNetworkPolicyAmendment: unknown }

type ServerRequestParams = {
  "item/commandExecution/requestApproval": {
    threadId: string
    turnId: string
    itemId: string
    command?: string | null
    cwd?: string | null
    reason?: string | null
    availableDecisions?: CommandDecision[] | null
  }
  "item/fileChange/requestApproval": {
    threadId: string
    turnId: string
    itemId: string
    reason?: string | null
    grantRoot?: string | null
  }
  "item/tool/requestUserInput": {
    threadId: string
    turnId: string
    itemId: string
    questions: Array<{
      id: string
      header: string
      question: string
      isOther: boolean
      isSecret: boolean
      options: Array<{ label: string; description: string }> | null
    }>
    isBlocking: boolean
  }
  "item/permissions/requestApproval": {
    threadId: string
    turnId: string
    itemId: string
    cwd: string
    reason: string | null
    permissions: JsonObject
  }
  "mcpServer/elicitation/request": {
    threadId: string
    turnId: string | null
    serverName: string
    mode: "form" | "openai/form" | "url"
    message: string
  }
}

type ServerRequestResults = {
  "item/commandExecution/requestApproval": { decision: CommandDecision }
  "item/fileChange/requestApproval": {
    decision: "accept" | "acceptForSession" | "decline" | "cancel"
  }
  "item/tool/requestUserInput": {
    answers: Record<string, { answers: string[] }>
  }
  "item/permissions/requestApproval": {
    permissions: JsonObject
    scope: "turn" | "session"
  }
  "mcpServer/elicitation/request": {
    action: "decline" | "cancel"
    content: null
    _meta: null
  }
}

type ServerRequestMethod = keyof ServerRequestParams
type PermissionChoice<R> = {
  optionId: string
  name: string
  kind?: string
  result: R
}
type PendingServerRequest = {
  [M in ServerRequestMethod]: {
    method: M
    rpcId: JsonRpcId
    turnId: string | null
    choices: Map<string, ServerRequestResults[M]>
    cancel: ServerRequestResults[M]
  }
}[ServerRequestMethod]

type ItemTracker = {
  acpId: string
  started: boolean
  textDelta: boolean
  text: string | null
  thinkingDelta: boolean
  thinking: string | null
  output: string
}

type Live = {
  id: string
  cwd: string
  child: ChildProcessWithoutNullStreams
  threadId: string | null
  currentTurnId: string | null
  state: AcpSessionState
  tuning?: Tuning
  nextRequestId: number
  pending: Map<string, PendingRpc>
  serverRequests: Map<string, PendingServerRequest>
  items: Map<string, ItemTracker>
  stdoutBuffer: string
  stderrBuffer: string
  decoder: StringDecoder
  startupTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

const STARTUP_TIMEOUT_MS = 10_000
const RPC_TIMEOUT_MS = 30_000
const MAX_STDOUT_BUFFER = 8 * 1024 * 1024
const MAX_STDERR_BUFFER = 16 * 1024
const MAX_TOOL_OUTPUT = 32 * 1024
const MAX_STREAM_COMPARE = 128 * 1024
const MAX_TRACKED_ITEMS = 2048
const MAX_REPLAY_ITEMS = 1000
const MAX_PROMPT_CHARS = 1_000_000
const sessions = new Map<string, Live>()
let sessionCounter = 0
let sendEvent: (event: HostEvent) => void = () => {}

export function bindCodexApp(send: (event: HostEvent) => void): void {
  sendEvent = send
}

export function codexAppState(id: string): AcpSessionState | null {
  return sessions.get(id)?.state ?? null
}

export async function codexAppStart(
  cwd: string,
  options: { resume?: string; title?: string; tuning?: Tuning } = {}
): Promise<AcpSessionState> {
  const id = `codex-app-${++sessionCounter}`
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
  const env = await accountEnv("codex", process.env)
  const child = spawn("codex", ["app-server"], {
    cwd: workingDir,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const live: Live = {
    id,
    cwd: workingDir,
    child,
    threadId: null,
    currentTurnId: null,
    state: {
      id,
      harness: "codex",
      cwd: workingDir,
      title: options.title,
      status: "starting",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    tuning: options.tuning,
    nextRequestId: 0,
    pending: new Map(),
    serverRequests: new Map(),
    items: new Map(),
    stdoutBuffer: "",
    stderrBuffer: "",
    decoder: new StringDecoder("utf8"),
    startupTimer: null,
    exited: false,
  }
  sessions.set(id, live)
  bindProcess(live)

  const startup = new Promise<never>((_, reject) => {
    live.startupTimer = setTimeout(
      () =>
        reject(new Error("Codex app-server did not start within 10 seconds")),
      STARTUP_TIMEOUT_MS
    )
  })
  try {
    const response = await Promise.race([
      openThread(live, options.resume),
      startup,
    ])
    clearStartupTimer(live)
    live.threadId = response.thread.id
    if (typeof response.thread.cwd === "string") live.cwd = response.thread.cwd
    replayHistory(live, response.thread.turns ?? [])
    updateState(live, {
      status: "ready",
      cwd: live.cwd,
      error: undefined,
    })
    return live.state
  } catch (error) {
    clearStartupTimer(live)
    const message = errorMessage(
      error,
      lastLine(live.stderrBuffer) || "Codex app-server failed to start"
    )
    failLive(live, message)
    sessions.delete(id)
    if (!child.killed) child.kill()
    throw new Error(message, { cause: error })
  }
}

export async function codexAppPrompt(
  id: string,
  text: string,
  attachments: AcpPromptAttachment[] = []
): Promise<void> {
  const live = sessions.get(id)
  if (!live?.threadId || live.exited)
    throw new Error("This Codex session is not running")
  if (live.state.status === "running")
    throw new Error("Codex is already working")
  if (!text.trim()) throw new Error("A prompt cannot be empty")
  if (text.length > MAX_PROMPT_CHARS)
    throw new Error("The prompt is too large for the Codex app-server adapter")

  updateState(live, {
    status: "running",
    error: undefined,
    lastStop: undefined,
  })
  emitUpdate(live, { kind: "user", text })
  try {
    const input: RpcParams["turn/start"]["input"] = [{ type: "text", text, textElements: [] }]
    for (const attachment of attachments) {
      if (attachment.path && attachment.mimeType.startsWith("image/")) {
        input.push({ type: "localImage", path: attachment.path })
      }
    }
    const result = await rpcRequest(live, "turn/start", {
      threadId: live.threadId,
      input,
      cwd: live.cwd,
      ...turnTuning(live.tuning),
    })
    if (isRunning(live)) live.currentTurnId = result.turn.id
  } catch (error) {
    const message = errorMessage(error, "Codex rejected the turn")
    updateState(live, { status: "ready", error: message, lastStop: "failed" })
    throw new Error(message, { cause: error })
  }
}

export function codexAppPermission(
  id: string,
  requestId: string,
  optionId: string | null
): void {
  const live = sessions.get(id)
  const pending = live?.serverRequests.get(requestId)
  if (!live || !pending) return
  live.serverRequests.delete(requestId)
  const result =
    optionId === null ? pending.cancel : pending.choices.get(optionId)
  if (result === undefined) {
    sendRpcError(live, pending.rpcId, -32602, "Unknown permission option")
    return
  }
  sendRpcResult(live, pending.rpcId, result)
}

export async function codexAppCancel(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.threadId || !live.currentTurnId || live.exited) return
  await rpcRequest(live, "turn/interrupt", {
    threadId: live.threadId,
    turnId: live.currentTurnId,
  }).catch(() => {})
}

export function codexAppClose(id: string): void {
  const live = sessions.get(id)
  if (!live) return
  updateState(live, { status: "closed" })
  sessions.delete(id)
  disposeLive(live, new Error("Codex session closed"))
  if (!live.child.killed) live.child.kill()
}

export function stopCodexApps(): void {
  for (const id of [...sessions.keys()]) codexAppClose(id)
}

async function openThread(
  live: Live,
  resume?: string
): Promise<ThreadResponse> {
  await rpcRequest(live, "initialize", {
    clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  sendRpc(live, { jsonrpc: "2.0", method: "initialized" })
  const tuning = threadTuning(live.tuning)
  return resume
    ? rpcRequest(live, "thread/resume", {
        threadId: resume,
        cwd: live.cwd,
        ...tuning,
      })
    : rpcRequest(live, "thread/start", { cwd: live.cwd, ...tuning })
}

function threadTuning(tuning?: Tuning): Omit<RpcParams["thread/start"], "cwd"> {
  const result: Omit<RpcParams["thread/start"], "cwd"> = {}
  const serviceTier = tuningServiceTier(tuning)
  if (tuning?.model) result.model = tuning.model
  if (serviceTier) result.serviceTier = serviceTier
  if (tuning?.effort) result.config = { model_reasoning_effort: tuning.effort }
  return result
}

function turnTuning(
  tuning?: Tuning
): Partial<Pick<RpcParams["turn/start"], "model" | "effort" | "serviceTier">> {
  const result: Partial<
    Pick<RpcParams["turn/start"], "model" | "effort" | "serviceTier">
  > = {}
  const serviceTier = tuningServiceTier(tuning)
  if (tuning?.model) result.model = tuning.model
  if (tuning?.effort) result.effort = tuning.effort
  if (serviceTier) result.serviceTier = serviceTier
  return result
}

function tuningServiceTier(tuning?: Tuning): string | undefined {
  const value = tuning?.options?.serviceTier ?? tuning?.options?.service_tier
  if (typeof value === "string" && value) return value
  return tuning?.fast ? "fast" : undefined
}

function bindProcess(live: Live): void {
  live.child.stdin.on("error", (error) => handleProcessEnd(live, error.message))
  live.child.stdout.on("data", (chunk: Buffer) => consumeStdout(live, chunk))
  live.child.stderr.on("data", (chunk: Buffer) => {
    live.stderrBuffer = tail(
      live.stderrBuffer + chunk.toString("utf8"),
      MAX_STDERR_BUFFER
    )
  })
  live.child.on("error", (error) => handleProcessEnd(live, error.message))
  live.child.on("exit", (code, signal) => {
    const detail = lastLine(live.stderrBuffer)
    const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
    handleProcessEnd(live, detail || `codex app-server exited with ${suffix}`)
  })
}

function consumeStdout(live: Live, chunk: Buffer): void {
  if (live.exited) return
  live.stdoutBuffer += live.decoder.write(chunk)
  if (Buffer.byteLength(live.stdoutBuffer, "utf8") > MAX_STDOUT_BUFFER) {
    handleProcessEnd(
      live,
      "Codex app-server sent an oversized JSON-RPC message"
    )
    if (!live.child.killed) live.child.kill()
    return
  }
  let newline = live.stdoutBuffer.indexOf("\n")
  while (newline >= 0) {
    const line = live.stdoutBuffer.slice(0, newline).replace(/\r$/, "")
    live.stdoutBuffer = live.stdoutBuffer.slice(newline + 1)
    if (line.trim()) processLine(live, line)
    if (live.exited) return
    newline = live.stdoutBuffer.indexOf("\n")
  }
}

function processLine(live: Live, line: string): void {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    handleProcessEnd(live, "Codex app-server sent invalid JSON-RPC")
    if (!live.child.killed) live.child.kill()
    return
  }
  if (!isRecord(message)) return
  if (
    (typeof message.id === "string" || typeof message.id === "number") &&
    ("result" in message || "error" in message)
  ) {
    settleRpc(live, message.id, message)
    return
  }
  if (typeof message.method !== "string") return
  if (typeof message.id === "string" || typeof message.id === "number") {
    handleServerRequest(
      live,
      message.id,
      message.method,
      isRecord(message.params) ? message.params : {}
    )
    return
  }
  handleNotification(
    live,
    message.method,
    isRecord(message.params) ? message.params : {}
  )
}

function settleRpc(live: Live, id: JsonRpcId, message: JsonObject): void {
  const pending = live.pending.get(rpcKey(id))
  if (!pending) return
  live.pending.delete(rpcKey(id))
  clearTimeout(pending.timer)
  if (isRecord(message.error)) {
    const detail =
      typeof message.error.message === "string"
        ? message.error.message
        : "Codex JSON-RPC request failed"
    pending.reject(new Error(detail))
    return
  }
  pending.resolve(message.result as never)
}

function handleNotification(
  live: Live,
  method: string,
  params: JsonObject
): void {
  if (
    typeof params.threadId === "string" &&
    live.threadId &&
    params.threadId !== live.threadId
  )
    return
  switch (method) {
    case "turn/started": {
      const turn = record(params.turn)
      if (typeof turn.id === "string") live.currentTurnId = turn.id
      if (live.state.status !== "running")
        updateState(live, { status: "running", error: undefined })
      return
    }
    case "turn/completed":
      completeTurn(live, record(params.turn) as Turn)
      return
    case "item/started":
      handleItem(
        live,
        stringValue(params.turnId),
        params.item as ThreadItem,
        false
      )
      return
    case "item/completed":
      handleItem(
        live,
        stringValue(params.turnId),
        params.item as ThreadItem,
        true
      )
      return
    case "item/agentMessage/delta":
      streamDelta(live, params, "text")
      return
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      streamDelta(live, params, "thinking")
      return
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      streamToolOutput(live, params, stringValue(params.delta))
      return
    case "item/fileChange/patchUpdated":
      updateToolOutput(live, params, boundedJson(params.changes))
      return
    case "item/mcpToolCall/progress":
      streamToolOutput(live, params, `${stringValue(params.message)}\n`)
      return
    case "turn/plan/updated": {
      const plan = Array.isArray(params.plan) ? params.plan : []
      emitUpdate(live, {
        kind: "plan",
        entries: plan.flatMap((raw) => {
          const step = record(raw)
          return typeof step.step === "string"
            ? [
                {
                  content: step.step,
                  status:
                    step.status === "inProgress"
                      ? "in_progress"
                      : stringValue(step.status),
                },
              ]
            : []
        }),
      })
      return
    }
    case "error": {
      const error = record(params.error)
      const message = stringValue(error.message) || "Codex encountered an error"
      updateState(live, { error: message })
      return
    }
    case "serverRequest/resolved": {
      const id = params.requestId
      if (typeof id === "string" || typeof id === "number")
        live.serverRequests.delete(String(id))
      return
    }
    case "thread/tokenUsage/updated":
      return
    default:
      return
  }
}

function completeTurn(live: Live, turn: Turn): void {
  if (!turn || typeof turn.id !== "string") return
  const error = turn.error?.message || undefined
  const stop = turn.status === "inProgress" ? "completed" : turn.status
  live.currentTurnId = null
  for (const [key, request] of live.serverRequests) {
    if (request.turnId === turn.id) live.serverRequests.delete(key)
  }
  for (const key of live.items.keys()) {
    if (key.startsWith(`${turn.id}\u0000`)) live.items.delete(key)
  }
  updateState(live, { status: "ready", lastStop: stop, error })
}

function streamDelta(
  live: Live,
  params: JsonObject,
  kind: "text" | "thinking"
): void {
  const turnId = stringValue(params.turnId)
  const itemId = stringValue(params.itemId)
  const delta = stringValue(params.delta)
  if (!turnId || !itemId || !delta) return
  const tracker = itemTracker(live, turnId, itemId)
  if (kind === "text") {
    tracker.textDelta = true
    tracker.text = appendComparable(tracker.text, delta)
  } else {
    tracker.thinkingDelta = true
    tracker.thinking = appendComparable(tracker.thinking, delta)
  }
  emitUpdate(live, { kind, text: delta })
}

function streamToolOutput(live: Live, params: JsonObject, delta: string): void {
  if (!delta) return
  const turnId = stringValue(params.turnId)
  const itemId = stringValue(params.itemId)
  if (!turnId || !itemId) return
  const tracker = itemTracker(live, turnId, itemId)
  tracker.output = tail(tracker.output + delta, MAX_TOOL_OUTPUT)
  emitUpdate(live, {
    kind: "tool-update",
    id: tracker.acpId,
    output: tracker.output,
  })
}

function updateToolOutput(
  live: Live,
  params: JsonObject,
  output: string
): void {
  const turnId = stringValue(params.turnId)
  const itemId = stringValue(params.itemId)
  if (!turnId || !itemId) return
  const tracker = itemTracker(live, turnId, itemId)
  tracker.output = boundedText(output, MAX_TOOL_OUTPUT)
  emitUpdate(live, {
    kind: "tool-update",
    id: tracker.acpId,
    output: tracker.output,
  })
}

function handleItem(
  live: Live,
  turnId: string,
  item: ThreadItem,
  completed: boolean,
  replay = false
): void {
  if (
    !turnId ||
    !isRecord(item) ||
    typeof item.type !== "string" ||
    typeof item.id !== "string"
  )
    return
  const tracker = itemTracker(live, turnId, item.id)
  switch (item.type) {
    case "userMessage":
      if (completed && replay) {
        const text = Array.isArray(item.content)
          ? item.content
              .map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
              .join("\n")
          : ""
        if (text) emitUpdate(live, { kind: "user", text })
      }
      return
    case "agentMessage":
      if (completed)
        emitFinalText(live, "text", item.text, tracker.textDelta, tracker.text)
      return
    case "reasoning":
      if (completed) {
        const final = [...(item.summary ?? []), ...(item.content ?? [])]
          .filter(Boolean)
          .join("\n\n")
        emitFinalText(
          live,
          "thinking",
          final,
          tracker.thinkingDelta,
          tracker.thinking
        )
      }
      return
    case "commandExecution":
      startTool(
        live,
        tracker,
        item.command || "Command",
        "execute",
        item.status
      )
      if (completed) {
        const output = item.aggregatedOutput ?? tracker.output
        finishTool(live, tracker, item.status, output || undefined)
      }
      return
    case "fileChange": {
      const paths = (item.changes ?? []).flatMap((change) =>
        typeof change.path === "string" ? [change.path] : []
      )
      startTool(
        live,
        tracker,
        paths.length ? `Edit ${paths.join(", ")}` : "File changes",
        "edit",
        item.status
      )
      if (completed)
        finishTool(live, tracker, item.status, boundedJson(item.changes))
      return
    }
    case "mcpToolCall":
      startTool(
        live,
        tracker,
        `${item.server}: ${item.tool}`,
        "fetch",
        item.status
      )
      if (completed) {
        const output =
          item.error?.message ||
          (item.result == null ? tracker.output : boundedJson(item.result))
        finishTool(live, tracker, item.status, output || undefined)
      }
      return
    case "dynamicToolCall":
      startTool(
        live,
        tracker,
        `${item.namespace ? `${item.namespace}.` : ""}${item.tool}`,
        "other",
        item.status
      )
      if (completed)
        finishTool(
          live,
          tracker,
          item.status,
          item.contentItems ? boundedJson(item.contentItems) : undefined
        )
      return
    default:
      return
  }
}

function startTool(
  live: Live,
  tracker: ItemTracker,
  title: string,
  toolKind: string,
  status: string
): void {
  if (tracker.started) return
  tracker.started = true
  emitUpdate(live, {
    kind: "tool",
    id: tracker.acpId,
    title: boundedText(title, 500),
    toolKind,
    status: toolStatus(status),
  })
}

function finishTool(
  live: Live,
  tracker: ItemTracker,
  status: string,
  output?: string
): void {
  emitUpdate(live, {
    kind: "tool-update",
    id: tracker.acpId,
    status: toolStatus(status),
    output: output ? boundedText(output, MAX_TOOL_OUTPUT) : undefined,
  })
}

function emitFinalText(
  live: Live,
  kind: "text" | "thinking",
  final: string,
  hadDelta: boolean,
  streamed: string | null
): void {
  if (!final) return
  if (!hadDelta) {
    emitTextChunks(live, kind, final)
    return
  }
  if (
    streamed !== null &&
    final.startsWith(streamed) &&
    final.length > streamed.length
  ) {
    emitTextChunks(live, kind, final.slice(streamed.length))
  }
}

function emitTextChunks(
  live: Live,
  kind: "text" | "thinking",
  text: string
): void {
  for (let offset = 0; offset < text.length; offset += MAX_TOOL_OUTPUT) {
    emitUpdate(live, {
      kind,
      text: text.slice(offset, offset + MAX_TOOL_OUTPUT),
    })
  }
}

function itemTracker(live: Live, turnId: string, itemId: string): ItemTracker {
  const key = `${turnId}\u0000${itemId}`
  const current = live.items.get(key)
  if (current) return current
  if (live.items.size >= MAX_TRACKED_ITEMS) {
    const oldest = live.items.keys().next().value as string | undefined
    if (oldest !== undefined) live.items.delete(oldest)
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
  live.items.set(key, tracker)
  return tracker
}

function replayHistory(live: Live, turns: Turn[]): void {
  const entries = turns.flatMap((turn) =>
    turn.items.map((item) => ({ turnId: turn.id, item }))
  )
  for (const entry of entries.slice(-MAX_REPLAY_ITEMS))
    handleItem(live, entry.turnId, entry.item, true, true)
  live.items.clear()
}

function handleServerRequest(
  live: Live,
  id: JsonRpcId,
  method: string,
  params: JsonObject
): void {
  switch (method) {
    case "item/commandExecution/requestApproval":
      requestCommandApproval(
        live,
        id,
        params as ServerRequestParams[typeof method]
      )
      return
    case "item/fileChange/requestApproval":
      requestFileApproval(
        live,
        id,
        params as ServerRequestParams[typeof method]
      )
      return
    case "item/tool/requestUserInput":
      requestUserInput(live, id, params as ServerRequestParams[typeof method])
      return
    case "item/permissions/requestApproval":
      requestPermissions(live, id, params as ServerRequestParams[typeof method])
      return
    case "mcpServer/elicitation/request":
      requestMcpElicitation(
        live,
        id,
        params as ServerRequestParams[typeof method]
      )
      return
    default:
      sendRpcError(live, id, -32601, `Unsupported server request: ${method}`)
  }
}

function requestCommandApproval(
  live: Live,
  id: JsonRpcId,
  params: ServerRequestParams["item/commandExecution/requestApproval"]
): void {
  const decisions = params.availableDecisions?.length
    ? params.availableDecisions
    : (["accept", "acceptForSession", "decline", "cancel"] as CommandDecision[])
  const choices = decisions.map(
    (decision, index): PermissionChoice<{ decision: CommandDecision }> => ({
      optionId: `decision:${index}`,
      name: decisionName(decision),
      kind: decisionKind(decision),
      result: { decision },
    })
  )
  const title =
    params.reason || params.command || "Codex wants to run a command"
  registerServerRequest(
    live,
    id,
    "item/commandExecution/requestApproval",
    params.turnId,
    title,
    "execute",
    choices,
    {
      decision: "cancel",
    }
  )
}

function requestFileApproval(
  live: Live,
  id: JsonRpcId,
  params: ServerRequestParams["item/fileChange/requestApproval"]
): void {
  const choices: Array<
    PermissionChoice<ServerRequestResults["item/fileChange/requestApproval"]>
  > = [
    {
      optionId: "accept",
      name: "Allow once",
      kind: "allow_once",
      result: { decision: "accept" },
    },
    {
      optionId: "acceptForSession",
      name: "Allow for session",
      kind: "allow_always",
      result: { decision: "acceptForSession" },
    },
    {
      optionId: "decline",
      name: "Deny",
      kind: "reject_once",
      result: { decision: "decline" },
    },
    {
      optionId: "cancel",
      name: "Deny and stop",
      kind: "reject_always",
      result: { decision: "cancel" },
    },
  ]
  const title =
    params.reason ||
    (params.grantRoot
      ? `Allow changes under ${params.grantRoot}`
      : "Codex wants to change files")
  registerServerRequest(
    live,
    id,
    "item/fileChange/requestApproval",
    params.turnId,
    title,
    "edit",
    choices,
    {
      decision: "cancel",
    }
  )
}

function requestUserInput(
  live: Live,
  id: JsonRpcId,
  params: ServerRequestParams["item/tool/requestUserInput"]
): void {
  const combinations = answerCombinations(params.questions)
  const choices: Array<
    PermissionChoice<ServerRequestResults["item/tool/requestUserInput"]>
  > = combinations.map((combination, index) => ({
    optionId: `answer:${index}`,
    name: combination.name,
    kind: "allow_once",
    result: { answers: combination.answers },
  }))
  choices.push({
    optionId: "cancel",
    name: "Cancel",
    kind: "reject_once",
    result: { answers: {} },
  })
  const title =
    params.questions.map((question) => question.question).join(" / ") ||
    "Codex needs input"
  registerServerRequest(
    live,
    id,
    "item/tool/requestUserInput",
    params.turnId,
    title,
    "other",
    choices,
    { answers: {} }
  )
}

function requestPermissions(
  live: Live,
  id: JsonRpcId,
  params: ServerRequestParams["item/permissions/requestApproval"]
): void {
  const choices: Array<
    PermissionChoice<ServerRequestResults["item/permissions/requestApproval"]>
  > = [
    {
      optionId: "turn",
      name: "Allow once",
      kind: "allow_once",
      result: { permissions: params.permissions, scope: "turn" },
    },
    {
      optionId: "session",
      name: "Allow for session",
      kind: "allow_always",
      result: { permissions: params.permissions, scope: "session" },
    },
    {
      optionId: "deny",
      name: "Deny",
      kind: "reject_once",
      result: { permissions: {}, scope: "turn" },
    },
  ]
  registerServerRequest(
    live,
    id,
    "item/permissions/requestApproval",
    params.turnId,
    params.reason || "Codex requests additional permissions",
    "execute",
    choices,
    { permissions: {}, scope: "turn" }
  )
}

function requestMcpElicitation(
  live: Live,
  id: JsonRpcId,
  params: ServerRequestParams["mcpServer/elicitation/request"]
): void {
  const choices: Array<
    PermissionChoice<ServerRequestResults["mcpServer/elicitation/request"]>
  > = [
    {
      optionId: "decline",
      name: "Decline",
      kind: "reject_once",
      result: { action: "decline", content: null, _meta: null },
    },
    {
      optionId: "cancel",
      name: "Cancel",
      kind: "reject_always",
      result: { action: "cancel", content: null, _meta: null },
    },
  ]
  registerServerRequest(
    live,
    id,
    "mcpServer/elicitation/request",
    params.turnId,
    `${params.serverName}: ${params.message}`,
    "fetch",
    choices,
    { action: "cancel", content: null, _meta: null }
  )
}

function registerServerRequest<M extends ServerRequestMethod>(
  live: Live,
  rpcId: JsonRpcId,
  method: M,
  turnId: string | null,
  title: string,
  kind: string,
  choices: Array<PermissionChoice<ServerRequestResults[M]>>,
  cancel: ServerRequestResults[M]
): void {
  const requestId = String(rpcId)
  if (live.serverRequests.has(requestId)) {
    sendRpcError(live, rpcId, -32600, "Duplicate server request id")
    return
  }
  const pending = {
    method,
    rpcId,
    turnId,
    choices: new Map(choices.map((choice) => [choice.optionId, choice.result])),
    cancel,
  } as PendingServerRequest
  live.serverRequests.set(requestId, pending)
  const request: AcpPermissionRequest = {
    id: requestId,
    sessionId: live.id,
    title: boundedText(title, 1000),
    kind,
    options: choices.map(({ optionId, name, kind: optionKind }) => ({
      optionId,
      name,
      kind: optionKind,
    })),
  }
  emit({ type: "acp-permission", request })
}

function answerCombinations(
  questions: ServerRequestParams["item/tool/requestUserInput"]["questions"]
): Array<{ name: string; answers: Record<string, { answers: string[] }> }> {
  let combinations: Array<{
    labels: string[]
    answers: Record<string, { answers: string[] }>
  }> = [{ labels: [], answers: {} }]
  for (const question of questions) {
    const options = question.options?.slice(0, 20) ?? []
    if (!options.length) return []
    const next: typeof combinations = []
    for (const combination of combinations) {
      for (const option of options) {
        next.push({
          labels: [...combination.labels, option.label],
          answers: {
            ...combination.answers,
            [question.id]: { answers: [option.label] },
          },
        })
        if (next.length >= 100) break
      }
      if (next.length >= 100) break
    }
    combinations = next
  }
  return combinations.map(({ labels, answers }) => ({
    name: labels.join(" / "),
    answers,
  }))
}

function decisionName(decision: CommandDecision): string {
  if (decision === "accept") return "Allow once"
  if (decision === "acceptForSession") return "Allow for session"
  if (decision === "decline") return "Deny"
  if (decision === "cancel") return "Deny and stop"
  if ("acceptWithExecpolicyAmendment" in decision)
    return "Allow matching commands"
  return "Apply network rule"
}

function decisionKind(decision: CommandDecision): string {
  if (decision === "accept") return "allow_once"
  if (decision === "acceptForSession" || typeof decision === "object")
    return "allow_always"
  return decision === "decline" ? "reject_once" : "reject_always"
}

function rpcRequest<M extends RpcMethod>(
  live: Live,
  method: M,
  params: RpcParams[M]
): Promise<RpcResults[M]> {
  if (live.exited || live.child.stdin.destroyed)
    return Promise.reject(new Error("Codex app-server is not running"))
  const id = ++live.nextRequestId
  return new Promise<RpcResults[M]>((resolve, reject) => {
    const timer = setTimeout(() => {
      live.pending.delete(rpcKey(id))
      reject(new Error(`Codex app-server did not answer ${method}`))
    }, RPC_TIMEOUT_MS)
    const pending = { method, resolve, reject, timer } as PendingRpc
    live.pending.set(rpcKey(id), pending)
    if (!sendRpc(live, { jsonrpc: "2.0", id, method, params })) {
      clearTimeout(timer)
      live.pending.delete(rpcKey(id))
      reject(new Error("Failed to write to Codex app-server"))
    }
  })
}

function sendRpc(live: Live, message: JsonObject): boolean {
  if (live.exited || live.child.stdin.destroyed || !live.child.stdin.writable)
    return false
  try {
    live.child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  } catch {
    return false
  }
}

function sendRpcResult(live: Live, id: JsonRpcId, result: unknown): void {
  sendRpc(live, { jsonrpc: "2.0", id, result })
}

function sendRpcError(
  live: Live,
  id: JsonRpcId,
  code: number,
  message: string
): void {
  sendRpc(live, { jsonrpc: "2.0", id, error: { code, message } })
}

function handleProcessEnd(live: Live, message: string): void {
  if (live.exited) return
  const wasClosed = live.state.status === "closed"
  disposeLive(live, new Error(message))
  if (!wasClosed) updateState(live, { status: "failed", error: message })
}

function failLive(live: Live, message: string): void {
  if (!live.exited) disposeLive(live, new Error(message))
  if (live.state.status !== "closed")
    updateState(live, { status: "failed", error: message })
}

function disposeLive(live: Live, error: Error): void {
  if (live.exited) return
  live.exited = true
  clearStartupTimer(live)
  for (const pending of live.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  live.pending.clear()
  live.serverRequests.clear()
  live.items.clear()
  live.stdoutBuffer = ""
  live.decoder.end()
}

function clearStartupTimer(live: Live): void {
  if (live.startupTimer) clearTimeout(live.startupTimer)
  live.startupTimer = null
}

function updateState(live: Live, patch: Partial<AcpSessionState>): void {
  live.state = { ...live.state, ...patch }
  emit({ type: "acp-session", session: live.state })
}

function emitUpdate(live: Live, update: AcpUpdate): void {
  if (
    (update.kind === "text" ||
      update.kind === "thinking" ||
      update.kind === "user") &&
    !update.text
  )
    return
  emit({ type: "acp-update", id: live.id, update })
}

function emit(event: HostEvent): void {
  try {
    sendEvent(event)
  } catch {
    return
  }
}

function isRunning(live: Live): boolean {
  return live.state.status === "running"
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

function boundedJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2)
    return boundedText(
      typeof json === "string" ? json : String(value),
      MAX_TOOL_OUTPUT
    )
  } catch {
    return "[unserializable output]"
  }
}

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const half = Math.floor((limit - 32) / 2)
  return `${value.slice(0, half)}\n… output truncated …\n${value.slice(-half)}`
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function rpcKey(id: JsonRpcId): string {
  return `${typeof id}:${id}`
}

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean)
  return boundedText(lines[lines.length - 1] ?? "", 500)
}
