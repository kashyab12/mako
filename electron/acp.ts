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
import { Readable, Writable } from "node:stream"
import { app } from "electron"
import {
  ClientSideConnection,
  CreateElicitationRequest as ElicitationRequest,
  ElicitationPropertySchema as ElicitationProperty,
  MultiSelectItems as MultiSelect,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ClientSideConnection as Connection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationContentValue,
  type ElicitationPropertySchema,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"
import { accountEnv } from "./accounts.js"
import { resolveAcpConfigValue } from "./acp-config.js"
import { normalizeAcpOptions } from "./harnesses.js"
import { providerHost } from "./providers/index.js"
import type { AcpTuning } from "./providers/acp-source.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { acpMcpServers } from "./mcp-runtime.js"
import type { McpTransport } from "./shared.js"
import type {
  AcpInputQuestion,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptAttachment,
  AcpSessionState,
  AcpUpdate,
  HostEvent,
} from "./shared.js"

interface ClaudeCodeOptions {
  model?: string
  effort?: string
  fastMode?: boolean
}

interface OpenedAcpSession {
  sessionId: string
  modes: SessionModeState | null
  configOptions: SessionConfigOption[]
}

interface LegacySessionModelRequest {
  sessionId: string
  modelId: string
}

interface AcpToolOutputBoundary {
  value: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call_update" }
  >["rawOutput"]
}

export function acpHarnesses(): string[] {
  const appPath = app.getAppPath()
  return providerHost.acpSources
    .list()
    .filter((source) => source.available(appPath))
    .map((source) => source.provider)
}

interface Live {
  id: string
  harness: string
  cwd: string
  child: ChildProcessWithoutNullStreams
  connection: Connection | null
  sessionId: string | null
  state: AcpSessionState
  pendingPermissions: Map<string, (response: AcpPermissionResponse) => void>
  promptCapabilities: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  mcpServers: McpServer[]
  turn: Promise<unknown> | null
}

const sessions = new Map<string, Live>()
let counter = 0
let emit: (event: HostEvent) => void = () => {}

export function bindAcp(send: (event: HostEvent) => void): void {
  emit = send
}

function elicitationOptions(
  values: string[] | null | undefined,
  titled:
    | Array<{ const: string; title: string; description?: string | null }>
    | null
    | undefined
): AcpInputQuestion["options"] {
  if (titled)
    return titled.map((option) => ({
      label: option.title,
      description: option.description ?? "",
      value: option.const,
    }))
  return (values ?? []).map((value) => ({
    label: value,
    description: "",
    value,
  }))
}

function elicitationQuestion(
  id: string,
  property: ElicitationPropertySchema,
  required: boolean
): AcpInputQuestion | null {
  if (ElicitationProperty.isString(property)) {
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: !property.enum && !property.oneOf,
      required,
      valueType: "string",
      options: elicitationOptions(property.enum, property.oneOf),
      defaultValues: property.default ? [property.default] : undefined,
    }
  }
  if (
    ElicitationProperty.isNumber(property) ||
    ElicitationProperty.isInteger(property)
  ) {
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: true,
      required,
      valueType: property.type,
      options: [],
      defaultValues:
        property.default === null || property.default === undefined
          ? undefined
          : [String(property.default)],
    }
  }
  if (ElicitationProperty.isBoolean(property)) {
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: false,
      required,
      valueType: "boolean",
      options: [
        { label: "Yes", description: "", value: "true" },
        { label: "No", description: "", value: "false" },
      ],
      defaultValues:
        property.default === null || property.default === undefined
          ? undefined
          : [String(property.default)],
    }
  }
  if (ElicitationProperty.isArray(property)) {
    const options = MultiSelect.isTitled(property.items)
      ? elicitationOptions(undefined, property.items.anyOf)
      : MultiSelect.isString(property.items)
        ? elicitationOptions(property.items.enum, undefined)
        : []
    if (options.length === 0) return null
    return {
      id,
      header: property.title ?? id,
      question: property.description ?? property.title ?? id,
      isSecret: false,
      allowOther: false,
      required,
      valueType: "string-array",
      options,
      defaultValues: property.default ?? undefined,
    }
  }
  return null
}

function elicitationContent(
  questions: AcpInputQuestion[],
  answers: Record<string, string[]>
): Record<string, ElicitationContentValue> | null {
  const content: Record<string, ElicitationContentValue> = {}
  for (const question of questions) {
    const values = answers[question.id] ?? []
    if (values.length === 0) {
      if (question.required) return null
      continue
    }
    if (question.valueType === "number" || question.valueType === "integer") {
      const value = Number(values[0])
      if (!Number.isFinite(value)) return null
      if (question.valueType === "integer" && !Number.isInteger(value))
        return null
      content[question.id] = value
    } else if (question.valueType === "boolean") {
      content[question.id] = values[0] === "true"
    } else if (question.valueType === "string-array") {
      content[question.id] = values
    } else {
      content[question.id] = values[0] ?? ""
    }
  }
  return content
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
  const request: AcpPermissionRequest = {
    id: requestId,
    sessionId: live.id,
    title: params.message,
    options: [],
    questions,
  }
  const response = await new Promise<AcpPermissionResponse>((resolve) => {
    live.pendingPermissions.set(requestId, resolve)
    emit({ type: "acp-permission", request })
  })
  live.pendingPermissions.delete(requestId)
  if (response.kind !== "answers") return { action: "decline" }
  const content = elicitationContent(questions, response.answers)
  return content ? { action: "accept", content } : { action: "decline" }
}

export function acpState(id: string): AcpSessionState | null {
  return sessions.get(id)?.state ?? null
}

/**
 * Start an interactive agent in `cwd`. With `resume`, the agent loads that
 * native session instead of starting empty — Claude Code's adapter supports
 * this, which makes "keep working on this exact session, interactively" real
 * rather than a transcript hand-off.
 */
export async function acpStart(
  harness: string,
  cwd: string,
  options: {
    resume?: string
    title?: string
    tuning?: AcpTuning
  } = {}
): Promise<AcpSessionState> {
  const source = providerHost.acpSources.get(harness)
  const spec = await source?.launch({
    appPath: app.getAppPath(),
    execPath: process.execPath,
    resume: options.resume,
    tuning: options.tuning,
  })
  if (!spec) throw new Error(`${harness} does not speak ACP here yet`)

  const id = `acp-${++counter}`
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

  const child = spawn(spec.command, spec.args, {
    cwd: workingDir,
    stdio: ["pipe", "pipe", "pipe"],
    env,
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
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    pendingPermissions: new Map(),
    promptCapabilities: {},
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
      error: lastLine(stderr) || `${spec.command} exited`,
    })
  })

  const client: Client = {
    async requestPermission(params: RequestPermissionRequest) {
      const requestId = `${id}-perm-${live.pendingPermissions.size}-${Date.now()}`
      const request: AcpPermissionRequest = {
        id: requestId,
        sessionId: id,
        title: params.toolCall?.title ?? "The agent wants to use a tool",
        kind: params.toolCall?.kind ?? undefined,
        options: params.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
        })),
      }
      const response = await new Promise<AcpPermissionResponse>((resolve) => {
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
      forward(live, params)
    },
  }

  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  )
  live.connection = connection

  try {
    const initialized = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        session: { configOptions: { boolean: {} } },
        elicitation: { form: {} },
      },
    })
    live.promptCapabilities =
      initialized.agentCapabilities?.promptCapabilities ?? {}
    const mcpCapabilities = initialized.agentCapabilities?.mcpCapabilities
    const transports: McpTransport[] = ["stdio"]
    if (mcpCapabilities?.http) transports.push("http")
    if (mcpCapabilities?.sse) transports.push("sse")
    live.mcpServers = providerHost.mcpSources.get(harness)
      ? acpMcpServers(mcpSnapshot, harness, transports)
      : []
    const session = options.resume
      ? parseLoadedAcpSession(
          await connection.loadSession(
            loadSessionRequest(
              options.resume,
              workingDir,
              harness,
              options.tuning,
              live.mcpServers
            )
          ),
          options.resume
        )
      : parseNewAcpSession(
          await connection.newSession(
            newSessionRequest(
              workingDir,
              harness,
              options.tuning,
              live.mcpServers
            )
          )
        )
    live.sessionId = session.sessionId
    const initialOptions = session.configOptions
    const hasModelOption = Boolean(
      options.tuning?.model &&
      findConfigOption(initialOptions, "model", options.tuning.model)
    )
    const rawOptions = await applyInitialTuning(
      live,
      initialOptions,
      options.tuning
    )
    if (options.tuning?.model && !hasModelOption) {
      await setLegacySessionModel(live, options.tuning.model)
    }
    update(live, {
      nativeId: session.sessionId,
      status: "ready",
      modes:
        session.modes?.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
        })) ?? [],
      currentMode: session.modes?.currentModeId ?? null,
      configOptions: normalizeAcpOptions(rawOptions),
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

function addClaudeSessionMetadata(
  request: NewSessionRequest | LoadSessionRequest,
  harness: string,
  tuning?: AcpTuning
): void {
  if (harness !== "claude" || !tuning) return
  const options: ClaudeCodeOptions = {}
  if (tuning.model) options.model = tuning.model
  if (tuning.effort) options.effort = tuning.effort
  if (tuning.fast !== undefined) options.fastMode = tuning.fast
  request._meta = { claudeCode: { options } }
}

function newSessionRequest(
  cwd: string,
  harness: string,
  tuning: AcpTuning | undefined,
  mcpServers: NewSessionRequest["mcpServers"]
): NewSessionRequest {
  const request: NewSessionRequest = { cwd, mcpServers }
  addClaudeSessionMetadata(request, harness, tuning)
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
  addClaudeSessionMetadata(request, harness, tuning)
  return request
}

function parseNewAcpSession(response: NewSessionResponse): OpenedAcpSession {
  return {
    sessionId: response.sessionId,
    modes: response.modes ?? null,
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
    configOptions: response.configOptions ?? [],
  }
}

async function applyInitialTuning(
  live: Live,
  initial: SessionConfigOption[],
  tuning?: AcpTuning
): Promise<SessionConfigOption[]> {
  const connection = live.connection
  const sessionId = live.sessionId
  if (!connection || !sessionId || !tuning) return initial

  let options = initial
  const selected = new Map<string, string | boolean>()
  if (tuning.options) {
    for (const [id, value] of Object.entries(tuning.options)) {
      selected.set(id, value)
    }
  }
  if (tuning.effort !== undefined && !selected.has("effort")) {
    selected.set("effort", tuning.effort)
  }
  if (tuning.fast !== undefined && !selected.has("fast")) {
    selected.set("fast", tuning.fast)
  }

  if (tuning.model) {
    const model = findConfigOption(options, "model", tuning.model)
    if (model) {
      const response = await connection.setSessionConfigOption({
        sessionId,
        configId: model.id,
        value: resolveAcpConfigValue(model, tuning.model),
      })
      options = response.configOptions
    }
  }

  const optionOrder = ["thinking", "context", "effort", "reasoning", "fast"]
  const ordered = Array.from(selected.entries()).sort(
    ([left], [right]) => optionOrder.indexOf(left) - optionOrder.indexOf(right)
  )
  for (const [id, value] of ordered) {
    const option = findConfigOption(options, id, value)
    if (!option) continue
    const response =
      value === true || value === false
        ? await connection.setSessionConfigOption({
            sessionId,
            configId: option.id,
            type: "boolean",
            value,
          })
        : await connection.setSessionConfigOption({
            sessionId,
            configId: option.id,
            value,
          })
    options = response.configOptions
  }
  return options
}

function findConfigOption(
  options: SessionConfigOption[],
  requestedId: string,
  value: string | boolean
): SessionConfigOption | null {
  const normalized = requestedId.toLowerCase()
  for (const option of options) {
    const identity =
      `${option.id} ${option.name} ${option.category ?? ""}`.toLowerCase()
    if (identity.includes(normalized)) return option
    if (
      requestedId === "model" &&
      value !== true &&
      value !== false &&
      option.type === "select" &&
      JSON.stringify(option.options).includes(value)
    ) {
      return option
    }
  }
  return null
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

/** Send the next message. Resolves when the turn ends; updates stream meanwhile. */
export async function acpPrompt(
  id: string,
  text: string,
  attachments: AcpPromptAttachment[] = []
): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection)
    throw new Error("This interactive session is not running")
  if (live.state.status === "running")
    throw new Error("The agent is already working")
  update(live, { status: "running" })
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
  const turn = live.connection
    .prompt({ sessionId: live.sessionId, prompt })
    .then((result) => {
      update(live, { status: "ready", lastStop: result.stopReason })
    })
    .catch((error) => {
      if (live.state.status !== "closed") {
        update(live, {
          status: "ready",
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
  response: AcpPermissionResponse
): void {
  sessions.get(id)?.pendingPermissions.get(requestId)?.(response)
}

export async function acpSetMode(id: string, modeId: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection) return
  await live.connection.setSessionMode({ sessionId: live.sessionId, modeId })
  update(live, { currentMode: modeId })
}

export async function acpCancel(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId || !live.connection) return
  await live.connection.cancel({ sessionId: live.sessionId }).catch(() => {})
}

export function acpClose(id: string): void {
  const live = sessions.get(id)
  if (!live) return
  update(live, { status: "closed" })
  for (const resolve of live.pendingPermissions.values())
    resolve({ kind: "choice", optionId: null })
  live.child.kill()
  sessions.delete(id)
}

export function stopAcp(): void {
  for (const id of sessions.keys()) acpClose(id)
}

/* ------------------------------------------------------------ translation */

/**
 * ACP updates, reduced to what the panel renders. Chunks stay chunks — the
 * renderer appends them — and tool calls carry their id so later updates
 * find the block they belong to.
 */
function forward(live: Live, notification: SessionNotification): void {
  const raw = notification.update
  let update: AcpUpdate
  switch (raw.sessionUpdate) {
    case "user_message_chunk":
      // Replayed history (session/load streams the past back). Live user
      // turns are emitted by acpPrompt itself and never arrive this way.
      update = { kind: "user", text: contentText(raw.content) }
      break
    case "agent_message_chunk":
      update = { kind: "text", text: contentText(raw.content) }
      break
    case "agent_thought_chunk":
      update = { kind: "thinking", text: contentText(raw.content) }
      break
    case "tool_call":
      update = {
        kind: "tool",
        id: raw.toolCallId,
        title: raw.title ?? "tool",
        toolKind: raw.kind,
        status: raw.status ?? "pending",
        input:
          raw.rawInput === undefined
            ? undefined
            : JSON.stringify(raw.rawInput, null, 2),
      }
      break
    case "tool_call_update":
      update = {
        kind: "tool-update",
        id: raw.toolCallId,
        title: raw.title ?? undefined,
        status: raw.status ?? undefined,
        input:
          raw.rawInput === undefined
            ? undefined
            : JSON.stringify(raw.rawInput, null, 2),
        output: parseAcpToolOutput({ value: raw.rawOutput }),
      }
      break
    case "plan":
      update = {
        kind: "plan",
        entries: (raw.entries ?? []).map((entry) => ({
          content: entry.content,
          status: entry.status,
        })),
      }
      break
    case "current_mode_update":
      updateState(live, { currentMode: raw.currentModeId })
      return
    case "config_option_update":
      updateState(live, {
        configOptions: normalizeAcpOptions(raw.configOptions),
      })
      return
    default:
      return // Command lists and the rest are not rendered yet.
  }
  if ((update.kind !== "text" && update.kind !== "user") || update.text) {
    emit({ type: "acp-update", id: live.id, update })
  }
}

function parseAcpToolOutput(
  boundary: AcpToolOutputBoundary
): string | undefined {
  const { value } = boundary
  if (value === undefined) return undefined
  if (Object.prototype.toString.call(value) === "[object String]") {
    return String(value).slice(0, 256_000)
  }
  return JSON.stringify(value, null, 2).slice(0, 256_000)
}

function contentText(content: ContentBlock): string {
  return content.type === "text" ? content.text : ""
}

function update(live: Live, patch: Partial<AcpSessionState>): void {
  updateState(live, patch)
}

function updateState(live: Live, patch: Partial<AcpSessionState>): void {
  live.state = { ...live.state, ...patch }
  emit({ type: "acp-session", session: live.state })
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean)
  return (lines[lines.length - 1] ?? "").slice(0, 300)
}
