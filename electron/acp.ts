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
 * request it must answer. Everything else — handshakes, schema versions,
 * process lifecycle — stays here.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { app } from "electron"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ClientSideConnection as Connection,
  type RequestPermissionRequest,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import { accountEnv } from "./accounts.js"
import type { AcpPermissionRequest, AcpSessionState, AcpUpdate, HostEvent } from "./shared.js"

interface AgentSpec {
  command: string
  args: string[]
}

/**
 * How each harness is spawned as an ACP agent. The Claude adapter is bundled
 * with the app (it is an npm dependency); Cursor's is the CLI itself.
 */
function specFor(harness: string): AgentSpec | null {
  switch (harness) {
    case "claude": {
      // The adapter is a bin script; run it with our own Node (Electron).
      const script = join(app.getAppPath(), "node_modules", "@zed-industries", "claude-code-acp", "dist", "index.js")
      return existsSync(script) ? { command: process.execPath, args: [script] } : null
    }
    case "cursor":
      return { command: "cursor-agent", args: ["acp"] }
    case "devin":
      return { command: devinExecutable() ?? "devin", args: ["acp"] }
    default:
      return null
  }
}

export function acpHarnesses(): string[] {
  return ["claude", "cursor", "devin"].filter((harness) => {
    const spec = specFor(harness)
    return Boolean(spec && (spec.command === "cursor-agent" || spec.command === "devin" || existsSync(spec.command)))
  })
}

function devinExecutable(): string | null {
  const configured = process.env["DEVIN_CLI_PATH"]
  if (configured && existsSync(configured)) return configured
  const direct = join(homedir(), ".local", "bin", "devin")
  if (existsSync(direct)) return direct
  if (process.platform !== "darwin") return null
  const registry = join(
    homedir(),
    "Library",
    "Application Support",
    "Zed",
    "external_agents",
    "registry",
    "devin"
  )
  try {
    for (const version of readdirSync(registry).sort().reverse()) {
      const executable = join(registry, version, "bin", "devin")
      if (existsSync(executable)) return executable
    }
  } catch {
    return null
  }
  return null
}

interface Live {
  id: string
  harness: string
  cwd: string
  child: ChildProcess
  connection: Connection
  sessionId: string | null
  state: AcpSessionState
  pendingPermissions: Map<string, (optionId: string | null) => void>
  turn: Promise<unknown> | null
}

const sessions = new Map<string, Live>()
let counter = 0
let emit: (event: HostEvent) => void = () => {}

export function bindAcp(send: (event: HostEvent) => void): void {
  emit = send
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
  options: { resume?: string; title?: string } = {}
): Promise<AcpSessionState> {
  const spec = specFor(harness)
  if (!spec) throw new Error(`${harness} does not speak ACP here yet`)

  const id = `acp-${++counter}`
  const workingDir = cwd && existsSync(cwd) ? cwd : homedir()

  // The nested-session guard: Claude Code refuses to start inside another
  // Claude Code. Mako is not one, but it may have been *launched from* one,
  // and the variable would be inherited. The selected account's config home
  // rides in the same way it does for headless runs.
  const env = await accountEnv(harness, process.env)
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT

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
    connection: null as unknown as Connection,
    sessionId: null,
    state: {
      id,
      harness,
      cwd: workingDir,
      title: options.title,
      status: "starting",
      modes: [],
      currentMode: null,
    },
    pendingPermissions: new Map(),
    turn: null,
  }
  sessions.set(id, live)

  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
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
      const chosen = await new Promise<string | null>((resolve) => {
        live.pendingPermissions.set(requestId, resolve)
        emit({ type: "acp-permission", request })
      })
      live.pendingPermissions.delete(requestId)
      if (chosen === null) return { outcome: { outcome: "cancelled" as const } }
      return { outcome: { outcome: "selected" as const, optionId: chosen } }
    },
    async sessionUpdate(params: SessionNotification) {
      forward(live, params)
    },
  }

  live.connection = new ClientSideConnection(
    () => client,
    ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    )
  )

  try {
    await live.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    const canLoad = typeof live.connection.loadSession === "function"
    const session =
      options.resume && canLoad
        ? await live.connection
            .loadSession({ sessionId: options.resume, cwd: workingDir, mcpServers: [] })
            .then(() => ({ sessionId: options.resume as string, modes: undefined }))
            .catch(async () => live.connection.newSession({ cwd: workingDir, mcpServers: [] }))
        : await live.connection.newSession({ cwd: workingDir, mcpServers: [] })
    if (!session) throw new Error("The agent did not open a session")
    live.sessionId = session.sessionId
    const modes = (session as { modes?: { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string } }).modes
    update(live, {
      status: "ready",
      modes: modes?.availableModes?.map((mode) => ({ id: mode.id, name: mode.name })) ?? [],
      currentMode: modes?.currentModeId ?? null,
    })
    return live.state
  } catch (error) {
    child.kill()
    sessions.delete(id)
    const detail = lastLine(stderr)
    throw new Error(
      detail || (error instanceof Error ? error.message : `The ${harness} agent failed to start`)
    )
  }
}

/** Send the next message. Resolves when the turn ends; updates stream meanwhile. */
export async function acpPrompt(id: string, text: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId) throw new Error("This interactive session is not running")
  if (live.state.status === "running") throw new Error("The agent is already working")
  update(live, { status: "running" })
  emit({ type: "acp-update", id, update: { kind: "user", text } })
  const turn = live.connection
    .prompt({ sessionId: live.sessionId, prompt: [{ type: "text", text }] })
    .then((result) => {
      update(live, { status: "ready", lastStop: result.stopReason })
    })
    .catch((error: unknown) => {
      if (live.state.status !== "closed") {
        update(live, { status: "ready", error: error instanceof Error ? error.message : String(error) })
      }
    })
  live.turn = turn
  await Promise.resolve()
}

export function acpRespondPermission(id: string, requestId: string, optionId: string | null): void {
  sessions.get(id)?.pendingPermissions.get(requestId)?.(optionId)
}

export async function acpSetMode(id: string, modeId: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId) return
  await live.connection.setSessionMode?.({ sessionId: live.sessionId, modeId })
  update(live, { currentMode: modeId })
}

export async function acpCancel(id: string): Promise<void> {
  const live = sessions.get(id)
  if (!live?.sessionId) return
  await live.connection.cancel?.({ sessionId: live.sessionId }).catch(() => {})
}

export function acpClose(id: string): void {
  const live = sessions.get(id)
  if (!live) return
  update(live, { status: "closed" })
  for (const resolve of live.pendingPermissions.values()) resolve(null)
  live.child.kill()
  sessions.delete(id)
}

export function stopAcp(): void {
  for (const id of [...sessions.keys()]) acpClose(id)
}

/* ------------------------------------------------------------ translation */

/**
 * ACP updates, reduced to what the panel renders. Chunks stay chunks — the
 * renderer appends them — and tool calls carry their id so later updates
 * find the block they belong to.
 */
function forward(live: Live, notification: SessionNotification): void {
  const raw = notification.update
  let update: AcpUpdate | null = null
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
      }
      break
    case "tool_call_update":
      update = {
        kind: "tool-update",
        id: raw.toolCallId,
        title: raw.title ?? undefined,
        status: raw.status ?? undefined,
        output: typeof raw.rawOutput === "string" ? raw.rawOutput.slice(0, 4000) : undefined,
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
    default:
      return // Command lists and the rest are not rendered yet.
  }
  if (update && ((update.kind !== "text" && update.kind !== "user") || update.text)) {
    emit({ type: "acp-update", id: live.id, update })
  }
}

function contentText(content: unknown): string {
  const rec = content as { type?: string; text?: string } | undefined
  return rec?.type === "text" && typeof rec.text === "string" ? rec.text : ""
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
