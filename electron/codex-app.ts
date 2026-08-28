import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { StringDecoder } from "node:string_decoder"
import { app } from "electron"
import { accountEnv } from "./accounts.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import {
  environmentForExecutable,
  resolveExecutable,
} from "./executable.js"
import { codexMcpConfig, mergeCodexConfig } from "./mcp-runtime.js"
import {
  clearTurnServerRequests,
  handleServerRequest,
  resolvePermission,
  resolveServerRequest,
  type PendingServerRequest,
  type PermissionCallbacks,
} from "./codex-app-permissions.js"
import { boundedText, type JsonObject } from "./codex-app-json.js"
import {
  consumeStdout,
  replayHistory,
  rpcRequest,
  sendRpc,
  sendRpcError,
  sendRpcResult,
} from "./codex-app-protocol.js"
import type {
  ItemTracker,
  PendingRpc,
  ProtocolCallbacks,
  RpcParams,
  ThreadResponse,
  Tuning,
} from "./codex-app-types.js"
import type {
  AcpPermissionResponse,
  AcpPromptAttachment,
  AcpSessionState,
  AcpUpdate,
  HostEvent,
  McpRegistrySnapshot,
} from "./shared.js"

type Live = {
  id: string
  cwd: string
  child: ChildProcessWithoutNullStreams
  threadId: string | null
  currentTurnId: string | null
  state: AcpSessionState
  tuning?: Tuning
  mcpSnapshot: McpRegistrySnapshot
  nextRequestId: number
  pending: Map<string, PendingRpc>
  serverRequests: Map<string, PendingServerRequest>
  items: Map<string, ItemTracker>
  stdoutBuffer: string
  stderrBuffer: string
  decoder: StringDecoder
  protocol: ProtocolCallbacks
  startupTimer: ReturnType<typeof setTimeout> | null
  replayUpdates: AcpUpdate[] | null
  exited: boolean
}

const STARTUP_TIMEOUT_MS = 10_000
const MAX_STDERR_BUFFER = 16 * 1024
const MAX_PROMPT_CHARS = 1_000_000
const sessions = new Map<string, Live>()
let sessionCounter = 0
let sendEvent: (event: HostEvent) => void = () => {}

const permissionCallbacks: PermissionCallbacks<Live> = {
  emit: (_live, event) => emit(event),
  sendResult: (live, id, result) => sendRpcResult(live, id, result),
  sendError: (live, id, code, message) => sendRpcError(live, id, code, message),
}

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
  const mcpSnapshot = await discoverMcpRegistry(workingDir, app.getAppPath())
  const env = await accountEnv("codex", process.env)
  const executable = resolveExecutable("codex", env)
  if (!executable) throw new Error("Codex is not installed")
  const child = spawn(executable, ["app-server"], {
    cwd: workingDir,
    env: environmentForExecutable(executable, env),
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
    mcpSnapshot,
    nextRequestId: 0,
    pending: new Map(),
    serverRequests: new Map(),
    items: new Map(),
    stdoutBuffer: "",
    stderrBuffer: "",
    decoder: new StringDecoder("utf8"),
    protocol: {
      handleFatal: (message) => protocolFatal(live, message),
      updateState: (patch) => updateState(live, patch),
      emitUpdate: (update) => emitUpdate(live, update),
      handleServerRequest: (rpcId, method, params) =>
        handleServerRequest(live, permissionCallbacks, rpcId, method, params),
      resolveServerRequest: (rpcId) => resolveServerRequest(live, rpcId),
      clearTurnServerRequests: (turnId) =>
        clearTurnServerRequests(live, turnId),
    },
    startupTimer: null,
    replayUpdates: null,
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
    if (response.thread.cwd !== undefined) live.cwd = response.thread.cwd
    const replayUpdates: AcpUpdate[] = []
    live.replayUpdates = replayUpdates
    try {
      replayHistory(live, response.thread.turns ?? [])
    } finally {
      live.replayUpdates = null
    }
    if (replayUpdates.length > 0)
      emit({ type: "acp-updates", id: live.id, updates: replayUpdates })
    updateState(live, {
      status: "ready",
      cwd: live.cwd,
      error: undefined,
    })
    return live.state
  } catch (error) {
    clearStartupTimer(live)
    const fallback =
      lastLine(live.stderrBuffer) || "Codex app-server failed to start"
    const message =
      error instanceof Error && error.message ? error.message : fallback
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
    const input: RpcParams["turn/start"]["input"] = [
      { type: "text", text, textElements: [] },
    ]
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
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Codex rejected the turn"
    updateState(live, { status: "ready", error: message, lastStop: "failed" })
    throw new Error(message, { cause: error })
  }
}

export function codexAppPermission(
  id: string,
  requestId: string,
  response: AcpPermissionResponse
): void {
  const live = sessions.get(id)
  if (!live) return
  resolvePermission(live, permissionCallbacks, requestId, response)
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
  for (const id of sessions.keys()) codexAppClose(id)
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
  const tuning = threadTuning(live.tuning, codexMcpConfig(live.mcpSnapshot))
  return resume
    ? rpcRequest(live, "thread/resume", {
        threadId: resume,
        cwd: live.cwd,
        ...tuning,
      })
    : rpcRequest(live, "thread/start", { cwd: live.cwd, ...tuning })
}

function threadTuning(
  tuning: Tuning | undefined,
  mcpConfig: JsonObject
): Omit<RpcParams["thread/start"], "cwd"> {
  const result: Omit<RpcParams["thread/start"], "cwd"> = {}
  const serviceTier = tuningServiceTier(tuning)
  const base = tuning?.effort
    ? { model_reasoning_effort: tuning.effort }
    : undefined
  const config = mergeCodexConfig(base, mcpConfig)
  if (tuning?.model) result.model = tuning.model
  if (serviceTier) result.serviceTier = serviceTier
  if (config) result.config = config
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
  if (Object.prototype.toString.call(value) === "[object String]" && value)
    return String(value)
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

function protocolFatal(live: Live, message: string): void {
  handleProcessEnd(live, message)
  if (!live.child.killed) live.child.kill()
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
  if (live.replayUpdates) {
    live.replayUpdates.push(update)
    return
  }
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

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit)
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean)
  return boundedText(lines[lines.length - 1] ?? "", 500)
}
