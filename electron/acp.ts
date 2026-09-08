import { z } from "zod"
import type { ConversationTools } from "./providers/live-driver.js"
/**
 * Interactive foreign agents, over ACP.
 *
 * The reply drivers run a harness's CLI headlessly — fine for one more turn,
 * blind for real work: no streaming, no steering, and tool approvals decided
 * in advance. ACP (the Agent Client Protocol) is the other mode: the agent
 * runs as a subprocess speaking JSON-RPC over stdio, streams every thought
 * and tool call as it happens, and *asks* before doing anything its mode
 * does not already allow — which is exactly the part headless running gives
 * up. Claude Code ships an official adapter; Cursor speaks it natively.
 *
 * This host keeps the protocol entirely on this side of the IPC boundary.
 * The renderer sees three things: a session (status, modes), a stream of
 * updates (text, thinking, tool calls, plan), and the occasional permission
 * or structured-input request it must answer. Everything else — handshakes, schema versions,
 * process lifecycle — stays here.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { acpReadable, acpWritable } from "./acp-stream.js"
import { app } from "electron"
import {
  ClientSideConnection,
  CreateElicitationRequest as ElicitationRequest,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ClientSideConnection as Connection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import { accountEnv } from "./accounts.js"
import { acpObservedSettings, applyAcpSettings } from "./acp-config.js"
import { elicitationContent, elicitationQuestion } from "./acp-elicitation.js"
import { forward } from "./acp-notifications.js"
import { normalizeAcpOptions } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import type { AcpTuning } from "./providers/acp-source.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { environmentForExecutable, resolveExecutable } from "./executable.js"
import { acpMcpServers } from "./mcp-runtime.js"
import type { McpTransport } from "./shared.js"
import type {
  LivePermissionRequest,
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveDriverEvent,
} from "./shared.js"

interface OpenedAcpSession {
  sessionId: string
  modes: SessionModeState | null
  model?: string
  configOptions: SessionConfigOption[]
}

interface LegacySessionModelRequest {
  sessionId: string
  modelId: string
}

interface Live {
  id: string
  harness: string
  cwd: string
  child: ChildProcessWithoutNullStreams
  connection: Connection | null
  sessionId: string | null
  state: LiveSessionState
  pendingPermissions: Map<string, (response: LivePermissionResponse) => void>
  promptCapabilities: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  configOptions: SessionConfigOption[]
  mcpServers: McpServer[]
  turn: Promise<unknown> | null
}

const sessions = new Map<string, Live>()
const STARTUP_TIMEOUT_MS = 20_000
let emit: (event: LiveDriverEvent) => void = () => {}

function startupStep<Value>(
  work: Promise<Value>,
  harness: string
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${harness} did not start within 20 seconds`)),
      STARTUP_TIMEOUT_MS
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function bindAcp(send: (event: LiveDriverEvent) => void): void {
  emit = send
}

async function requestElicitation(
  live: Live,
  params: CreateElicitationRequest
): Promise<CreateElicitationResponse> {
  if (!ElicitationRequest.isForm(params)) return { action: "cancel" }
  const required = new Set(params.requestedSchema.required ?? [])
  const questions = Object.entries(params.requestedSchema.properties ?? {})
    .map(([id, property]) =>
      elicitationQuestion(id, property, required.has(id))
    )
    .filter((question) => question !== null)
  if (
    questions.length !==
    Object.keys(params.requestedSchema.properties ?? {}).length
  )
    return { action: "cancel" }
  const requestId = `${live.id}-input-${live.pendingPermissions.size}-${Date.now()}`
  const request: LivePermissionRequest = {
    id: requestId,
    sessionId: live.id,
    title: params.message,
    options: [],
    questions,
  }
  const response = await new Promise<LivePermissionResponse>((resolve) => {
    live.pendingPermissions.set(requestId, resolve)
    emit({ type: "acp-permission", request })
  })
  live.pendingPermissions.delete(requestId)
  if (response.kind !== "answers") return { action: "decline" }
  const content = elicitationContent(questions, response.answers)
  return content ? { action: "accept", content } : { action: "decline" }
}

export function acpState(id: string): LiveSessionState | null {
  return sessions.get(id)?.state ?? null
}

/**
 * Start an interactive agent in `cwd`. With `resume`, the agent loads that
 * native session instead of starting empty — Claude Code's adapter supports
 * this, which makes "keep working on this exact session, interactively" real
 * rather than a transcript hand-off.
 */
export async function liveStart(
  harness: string,
  cwd: string,
  options: {
    conversationId: string
    conversationTools?: ConversationTools
    resume?: string
    title?: string
    tuning?: AcpTuning
  }
): Promise<LiveSessionState> {
  const source = providerHost.acpSources.get(harness)
  const spec = await source?.launch({
    appPath: app.getAppPath(),
    execPath: process.execPath,
    resume: options.resume,
    tuning: options.tuning,
  })
  if (!spec) throw new Error(`${harness} does not speak ACP here yet`)

  const id = options.conversationId
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()
  const mcpSnapshot = await discoverMcpRegistry(workingDir, app.getAppPath())

  // The nested-session guard: Claude Code refuses to start inside another
  // Claude Code. Mako is not one, but it may have been *launched from* one,
  // and the variable would be inherited. The selected account's config home
  // rides in the same way it does for headless runs.
  const env = await accountEnv(harness, process.env)
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  spec.configureEnvironment(env)
  const executable = resolveExecutable(spec.command, env)
  if (!executable) throw new Error(`${harness} is not installed`)

  const conversationMcp: McpServer | null = options.conversationTools ? {
    type: "http",
    name: "mako-conversations",
    url: options.conversationTools.url,
    headers: [{ name: "Authorization", value: `Bearer ${options.conversationTools.token}` }],
  } : null
  const preparedServers = acpMcpServers(mcpSnapshot, harness, ["stdio", "http", "sse"], options.conversationTools?.control, id)
  if (conversationMcp) preparedServers.push(conversationMcp)
  const disposeMcp = await spec.prepareMcp?.(preparedServers, env)
  const child = spawn(executable, spec.args, {
    cwd: workingDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: environmentForExecutable(executable, env),
  })

  child.once("close", () => {
    void disposeMcp?.().catch(() => console.error("Provider MCP configuration cleanup failed"))
  })

  const live: Live = {
    id,
    harness,
    cwd: workingDir,
    child,
    connection: null,
    sessionId: null,
    state: {
      id,
      harness,
      cwd: workingDir,
      title: options.title,
      status: "starting",
      connection: "starting",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    pendingPermissions: new Map(),
    promptCapabilities: {},
    configOptions: [],
    mcpServers: [],
    turn: null,
  }
  sessions.set(id, live)

  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  child.on("exit", () => {
    if (live.state.status === "closed") return
    update(live, {
      status: "failed",
      connection: "disconnected",
      error: lastLine(stderr) || `${spec.command} exited`,
    })
  })

  const client: Client = {
    async requestPermission(params: RequestPermissionRequest) {
      const requestId = `${id}-perm-${live.pendingPermissions.size}-${Date.now()}`
      const request: LivePermissionRequest = {
        id: requestId,
        sessionId: id,
        title:
          params.toolCall?.title ??
          spec.permissionTitle?.(params) ??
          "The agent wants to use a tool",
        kind: params.toolCall?.kind ?? undefined,
        options: params.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
        })),
      }
      const response = await new Promise<LivePermissionResponse>((resolve) => {
        live.pendingPermissions.set(requestId, resolve)
        emit({ type: "acp-permission", request })
      })
      live.pendingPermissions.delete(requestId)
      const chosen = response.kind === "choice" ? response.optionId : null
      if (chosen === null) return { outcome: { outcome: "cancelled" as const } }
      return { outcome: { outcome: "selected" as const, optionId: chosen } }
    },
    async unstable_createElicitation(params: CreateElicitationRequest) {
      return requestElicitation(live, params)
    },
    async sessionUpdate(params: SessionNotification) {
      if (params.update.sessionUpdate === "config_option_update") live.configOptions = params.update.configOptions
      forward(live, params, emit, updateState, live.state.settings)
    },
  }

  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout))
  )
  live.connection = connection

  try {
    const initialized = await startupStep(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          session: { configOptions: { boolean: {} } },
          elicitation: { form: {} },
        },
      }),
      harness
    )
    live.promptCapabilities =
      initialized.agentCapabilities?.promptCapabilities ?? {}
    const mcpCapabilities = initialized.agentCapabilities?.mcpCapabilities
    const transports: McpTransport[] = ["stdio"]
    if (mcpCapabilities?.http) transports.push("http")
    if (mcpCapabilities?.sse) transports.push("sse")
    live.mcpServers = providerHost.mcpSources.get(harness)
      ? acpMcpServers(
          mcpSnapshot,
          harness,
          transports,
          options.conversationTools?.control,
          id
        )
      : []
    if (conversationMcp && mcpCapabilities?.http) live.mcpServers.push(conversationMcp)
    const session = options.resume
      ? parseLoadedAcpSession(
          await startupStep(
            connection.loadSession(
              loadSessionRequest(
                options.resume,
                workingDir,
                harness,
                options.tuning,
                live.mcpServers
              )
            ),
            harness
          ),
          options.resume
        )
      : parseNewAcpSession(
          await startupStep(
            connection.newSession(
              newSessionRequest(
                workingDir,
                harness,
                options.tuning,
                live.mcpServers
              )
            ),
            harness
          )
        )
    live.sessionId = session.sessionId
    live.configOptions = session.configOptions
    live.state.settings = acpObservedSettings(session.configOptions, session.model)
    const applied = await applyTuning(live, options.tuning, true)
    update(live, {
      nativeId: session.sessionId,
      status: "ready",
      connection: "connected",
      modes:
        session.modes?.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
        })) ?? [],
      currentMode: session.modes?.currentModeId ?? null,
      configOptions: normalizeAcpOptions(applied.options),
      settings: applied.settings,
    })
    return live.state
  } catch (error) {
    child.kill()
    sessions.delete(id)
    const detail = lastLine(stderr)
    throw new Error(
      detail ||
        (error instanceof Error
          ? error.message
          : `The ${harness} agent failed to start`),
      { cause: error }
    )
  }
}

function newSessionRequest(
  cwd: string,
  harness: string,
  tuning: AcpTuning | undefined,
  mcpServers: NewSessionRequest["mcpServers"]
): NewSessionRequest {
  const request: NewSessionRequest = { cwd, mcpServers }
  if (tuning) request._meta = providerHost.acpSources.get(harness)?.sessionMetadata?.(tuning)
  return request
}

function loadSessionRequest(
  sessionId: string,
  cwd: string,
  harness: string,
  tuning: AcpTuning | undefined,
  mcpServers: LoadSessionRequest["mcpServers"]
): LoadSessionRequest {
  const request: LoadSessionRequest = { sessionId, cwd, mcpServers }
  if (tuning) request._meta = providerHost.acpSources.get(harness)?.sessionMetadata?.(tuning)
  return request
}

const LegacyAcpModelsSchema = z.object({ models: z.object({ currentModelId: z.string() }).nullish() })

function legacyAcpModel(response: NewSessionResponse | LoadSessionResponse): string | undefined {
  const parsed = LegacyAcpModelsSchema.safeParse(response)
  return parsed.success ? parsed.data.models?.currentModelId : undefined
}

function parseNewAcpSession(response: NewSessionResponse): OpenedAcpSession {
  return {
    sessionId: response.sessionId,
    modes: response.modes ?? null,
    model: legacyAcpModel(response),
    configOptions: response.configOptions ?? [],
  }
}

function parseLoadedAcpSession(
  response: LoadSessionResponse,
  sessionId: string
): OpenedAcpSession {
  return {
    sessionId,
    modes: response.modes ?? null,
    model: legacyAcpModel(response),
    configOptions: response.configOptions ?? [],
  }
}

async function applyTuning(live: Live, tuning?: AcpTuning, initial = false) {
  const connection = live.connection
  const sessionId = live.sessionId
  if (!connection || !sessionId) throw new Error("This provider session is not connected")
  const result = await applyAcpSettings({
    settings: tuning ?? {},
    observed: live.state.settings ?? {},
    options: live.configOptions,
    launchOptionIds: initial ? providerHost.acpSources.get(live.harness)?.launchOptionIds : undefined,
    setModel: (model) => setLegacySessionModel(live, model),
    setOption: async (option, value) => {
      const response = value === true || value === false
        ? await connection.setSessionConfigOption({ sessionId, configId: option.id, type: "boolean", value })
        : await connection.setSessionConfigOption({ sessionId, configId: option.id, value })
      return response.configOptions
    },
  })
  live.configOptions = result.options
  return result
}

async function setLegacySessionModel(
  live: Live,
  modelId: string
): Promise<void> {
  const connection = live.connection
  const sessionId = live.sessionId
  if (!connection || !sessionId) return
  await connection.request<void, LegacySessionModelRequest>(
    "session/set_model",
    {
      sessionId,
      modelId,
    }
  )
}

/** Send the next message. Resolves when the provider accepts the turn. */
export async function livePrompt(
  id: string,
  text: string,
  attachments: PromptAttachment[] = [],
  tuning?: AcpTuning
): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection)
    throw new Error("This interactive session is not running")
  if (live.state.status === "running")
    throw new Error("The agent is already working")
  const connection = live.connection
  const sessionId = live.sessionId
  const applied = await applyTuning(live, tuning)
  update(live, { status: "running", settings: applied.settings, configOptions: normalizeAcpOptions(applied.options) })
  emit({ type: "acp-update", id, update: { kind: "user", text } })
  const prompt: ContentBlock[] = [{ type: "text", text }]
  for (const attachment of attachments) {
    if (
      attachment.data &&
      attachment.mimeType.startsWith("image/") &&
      live.promptCapabilities.image
    ) {
      prompt.push({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
      })
    } else if (attachment.path) {
      prompt.push({
        type: "resource_link",
        name: attachment.name,
        uri: pathToFileURL(attachment.path).href,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })
    }
  }
  const turn = Promise.resolve()
    .then(() => connection.prompt({ sessionId, prompt }))
    .then((result) => {
      if (live.state.status !== "closed")
        update(live, { status: "ready", lastStop: result.stopReason })
    })
    .catch((error) => {
      if (live.state.status !== "closed") {
        update(live, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  live.turn = turn
  await Promise.resolve()
}

export function acpRespondPermission(
  id: string,
  requestId: string,
  response: LivePermissionResponse
): void {
  sessions.get(id)?.pendingPermissions.get(requestId)?.(response)
}

export async function liveSetMode(id: string, modeId: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection) return
  await live.connection.setSessionMode({ sessionId: live.sessionId, modeId })
  update(live, { currentMode: modeId })
}

export async function liveCancel(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection) return
  await live.connection.cancel({ sessionId: live.sessionId })
}

export function liveClose(id: string): void {
  const live = sessions.get(id)
  if (!live) return
  update(live, { status: "closed" })
  for (const resolve of live.pendingPermissions.values())
    resolve({ kind: "choice", optionId: null })
  live.child.kill()
  sessions.delete(id)
}

export function stopAcp(): void {
  for (const id of sessions.keys()) liveClose(id)
}

function update(live: Live, patch: Partial<LiveSessionState>): void {
  updateState(live, patch)
}

function updateState(live: Live, patch: Partial<LiveSessionState>): void {
  if (patch.configOptions && !patch.settings) {
    patch.settings = acpObservedSettings(live.configOptions, live.state.settings?.model)
  }
  live.state = { ...live.state, ...patch }
  emit({ type: "acp-session", session: live.state })
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean)
  return (lines[lines.length - 1] ?? "").slice(0, 300)
}
