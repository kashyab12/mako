import { createServer, createConnection, type Server, type Socket } from "node:net"
import { mkdir, chmod, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn as spawnPty, type IDisposable, type IPty } from "@lydell/node-pty"
import { z } from "zod"
import type { TerminalSession } from "./shared.js"
import {
  BoundedTerminalHistory,
  JsonLineDecoder,
  TERMINAL_DAEMON_VERSION,
  TERMINAL_MAX_SESSIONS,
  TERMINAL_PROTOCOL_VERSION,
  encodeTerminalFrame,
  parseTerminalRequest,
  splitTerminalOutput,
  type TerminalDaemonEvent,
  type TerminalRequest,
  type TerminalResponse,
  type TerminalResult,
} from "./terminal-protocol.js"

interface LiveSession {
  summary: TerminalSession
  history: BoundedTerminalHistory
  pty: IPty | null
  dataListener?: IDisposable
  exitListener?: IDisposable
}

interface ClientConnection {
  socket: Socket
  decoder: JsonLineDecoder
  blocked: boolean
  missedOutput: boolean
  attachedSessionId?: string
}

interface PersistedSession {
  summary: TerminalSession
  history: string
}

interface PersistedState {
  version: number
  savedAt: number
  sessions: PersistedSession[]
}

const persistedSessionSchema = z.object({
  history: z.string(),
  summary: z.object({
    id: z.string(),
    title: z.string(),
    cwd: z.string(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    status: z.enum(["running", "exited", "interrupted"]),
    cols: z.number().int(),
    rows: z.number().int(),
    sequence: z.number().int(),
    exitCode: z.number().int().optional(),
  }),
})
const persistedStateSchema = z.object({
  version: z.literal(TERMINAL_PROTOCOL_VERSION),
  savedAt: z.number().finite(),
  sessions: z.array(persistedSessionSchema).max(TERMINAL_MAX_SESSIONS),
})
const errnoSchema = z.object({ code: z.string() })

const endpoint = argument("--endpoint")
const stateDir = argument("--state-dir")
const historyFile = join(stateDir, "sessions.json")
const historyTemp = join(stateDir, "sessions.tmp")
const sessions = new Map<string, LiveSession>()
const clients = new Set<ClientConnection>()
let server: Server | null = null
let dirty = false
let saving: Promise<void> | null = null
let stopping = false

function argument(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function sessionCopy(session: TerminalSession): TerminalSession {
  return { ...session }
}

function response(
  id: number,
  result: TerminalResult,
  protocol = TERMINAL_PROTOCOL_VERSION
): TerminalResponse {
  return {
    protocol,
    type: "response",
    id,
    ok: true,
    result,
  }
}

function failure(
  id: number,
  error: string,
  code: TerminalResponse["code"] = "invalid-request"
): TerminalResponse {
  return {
    protocol: TERMINAL_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error,
    code,
  }
}

function send(connection: ClientConnection, frame: TerminalResponse | TerminalDaemonEvent) {
  if (!connection.socket.write(encodeTerminalFrame(frame))) connection.blocked = true
}

function broadcast(event: TerminalDaemonEvent, sessionId?: string) {
  const frame = encodeTerminalFrame(event)
  for (const client of clients) {
    if (sessionId && client.attachedSessionId !== sessionId) continue
    if (client.blocked) {
      if (sessionId) client.missedOutput = true
      continue
    }
    if (!client.socket.write(frame)) client.blocked = true
  }
}

function publishStatus(session: LiveSession) {
  broadcast({
    protocol: TERMINAL_PROTOCOL_VERSION,
    type: "status",
    session: sessionCopy(session.summary),
  })
}

function markDirty() {
  dirty = true
}

function listSessions() {
  return [...sessions.values()]
    .map((session) => sessionCopy(session.summary))
    .sort((left, right) => right.createdAt - left.createdAt)
}

function shellCommand() {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC ?? "powershell.exe", args: [] }
  }
  return { file: process.env.SHELL ?? "/bin/sh", args: ["-l"] }
}

function createSession(request: Extract<TerminalRequest, { type: "create" }>) {
  if (sessions.size >= TERMINAL_MAX_SESSIONS) {
    throw new Error(`Terminal session limit reached (${TERMINAL_MAX_SESSIONS})`)
  }
  const shell = shellCommand()
  const now = Date.now()
  const id = randomUUID()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }
  delete env.ELECTRON_RUN_AS_NODE
  const pty = spawnPty(shell.file, shell.args, {
    name: "xterm-256color",
    cwd: request.cwd,
    cols: request.cols,
    rows: request.rows,
    env,
  })
  const session: LiveSession = {
    summary: {
      id,
      title: request.title?.trim() || basename(request.cwd) || "Terminal",
      cwd: request.cwd,
      createdAt: now,
      updatedAt: now,
      status: "running",
      cols: request.cols,
      rows: request.rows,
      sequence: 0,
    },
    history: new BoundedTerminalHistory(),
    pty,
  }
  session.dataListener = pty.onData((data) => receiveOutput(session, data))
  session.exitListener = pty.onExit(({ exitCode }) => finishSession(session, exitCode))
  sessions.set(id, session)
  markDirty()
  publishStatus(session)
  return session
}

function receiveOutput(session: LiveSession, data: string) {
  for (const chunk of splitTerminalOutput(data)) {
    session.history.append(chunk)
    session.summary.sequence += 1
    session.summary.updatedAt = Date.now()
    broadcast(
      {
        protocol: TERMINAL_PROTOCOL_VERSION,
        type: "output",
        sessionId: session.summary.id,
        sequence: session.summary.sequence,
        data: chunk,
      },
      session.summary.id
    )
  }
  markDirty()
}

function finishSession(session: LiveSession, exitCode: number) {
  if (sessions.get(session.summary.id) !== session) return
  session.pty = null
  session.dataListener?.dispose()
  session.exitListener?.dispose()
  session.dataListener = undefined
  session.exitListener = undefined
  session.summary.status = "exited"
  session.summary.exitCode = exitCode
  session.summary.updatedAt = Date.now()
  markDirty()
  publishStatus(session)
  void persist()
}

function getSession(id: string) {
  const session = sessions.get(id)
  if (!session) throw new Error("Terminal session was not found")
  return session
}

async function handleRequest(connection: ClientConnection, request: TerminalRequest) {
  try {
    if (request.type === "hello") {
      send(
        connection,
        response(
          request.id,
          {
            kind: "hello",
            daemonVersion: TERMINAL_DAEMON_VERSION,
            pid: process.pid,
          },
          request.protocol
        )
      )
      return
    }
    if (request.type === "list") {
      send(connection, response(request.id, { kind: "sessions", sessions: listSessions() }))
      return
    }
    if (request.type === "create") {
      const session = createSession(request)
      send(connection, response(request.id, { kind: "session", session: sessionCopy(session.summary) }))
      return
    }
    if (request.type === "attach") {
      const session = getSession(request.sessionId)
      connection.attachedSessionId = request.sessionId
      send(
        connection,
        response(request.id, {
          kind: "snapshot",
          snapshot: {
            session: sessionCopy(session.summary),
            data: session.history.text(),
            sequence: session.summary.sequence,
          },
        })
      )
      return
    }
    if (request.type === "write") {
      const session = getSession(request.sessionId)
      if (!session.pty || session.summary.status !== "running") {
        throw new Error("This terminal is not running. Start a new terminal to continue.")
      }
      session.pty.write(request.data)
      send(connection, response(request.id, { kind: "ok" }))
      return
    }
    if (request.type === "resize") {
      const session = getSession(request.sessionId)
      session.summary.cols = request.cols
      session.summary.rows = request.rows
      session.summary.updatedAt = Date.now()
      session.pty?.resize(request.cols, request.rows)
      markDirty()
      publishStatus(session)
      send(connection, response(request.id, { kind: "ok" }))
      return
    }
    if (request.type === "kill") {
      const session = getSession(request.sessionId)
      session.dataListener?.dispose()
      session.exitListener?.dispose()
      session.pty?.kill()
      sessions.delete(request.sessionId)
      markDirty()
      broadcast({
        protocol: TERMINAL_PROTOCOL_VERSION,
        type: "removed",
        sessionId: request.sessionId,
      })
      send(connection, response(request.id, { kind: "ok" }))
      void persist()
      return
    }
    if (request.type === "replace") {
      await persist(true)
      send(
        connection,
        response(request.id, { kind: "ok" }, request.protocol)
      )
      setTimeout(() => void shutdown(0), 25)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = message.includes("limit") ? "limit" : message.includes("not found") ? "not-found" : "invalid-request"
    send(connection, failure(request.id, message, code))
  }
}

function accept(socket: Socket) {
  socket.setNoDelay(true)
  const connection: ClientConnection = {
    socket,
    decoder: new JsonLineDecoder(),
    blocked: false,
    missedOutput: false,
  }
  clients.add(connection)
  socket.on("drain", () => {
    connection.blocked = false
    if (!connection.missedOutput || !connection.attachedSessionId) return
    connection.missedOutput = false
    const session = sessions.get(connection.attachedSessionId)
    if (session) {
      send(connection, {
        protocol: TERMINAL_PROTOCOL_VERSION,
        type: "status",
        session: sessionCopy(session.summary),
      })
    }
  })
  socket.on("data", (chunk) => {
    try {
      for (const value of connection.decoder.push(chunk)) {
        const request = parseTerminalRequest(value)
        if (request) void handleRequest(connection, request)
        else send(connection, failure(0, "Invalid terminal protocol request"))
      }
    } catch (error) {
      send(connection, failure(0, error instanceof Error ? error.message : String(error)))
      socket.destroy()
    }
  })
  const drop = () => clients.delete(connection)
  socket.on("close", drop)
  socket.on("error", drop)
}

async function persist(force = false) {
  if (saving) {
    await saving
    if (!force || !dirty) return
  }
  if (!dirty && !force) return
  dirty = false
  const state: PersistedState = {
    version: TERMINAL_PROTOCOL_VERSION,
    savedAt: Date.now(),
    sessions: [...sessions.values()].map((session) => ({
      summary: sessionCopy(session.summary),
      history: session.history.base64(),
    })),
  }
  saving = writeFile(historyTemp, JSON.stringify(state), { mode: 0o600 })
    .then(() => rename(historyTemp, historyFile))
    .catch(() => {
      dirty = true
    })
    .finally(() => {
      saving = null
    })
  return saving
}

async function restore() {
  try {
    const parsed = persistedStateSchema.safeParse(
      JSON.parse(await readFile(historyFile, "utf8"))
    )
    if (!parsed.success) return
    for (const saved of parsed.data.sessions) {
      const history = new BoundedTerminalHistory()
      history.restore(saved.history)
      sessions.set(saved.summary.id, {
        summary: {
          ...saved.summary,
          status:
            saved.summary.status === "running"
              ? "interrupted"
              : saved.summary.status,
        },
        history,
        pty: null,
      })
    }
  } catch {
    return
  }
}

function probe(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path)
    const done = (active: boolean) => {
      socket.destroy()
      resolve(active)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

function listen(instance: Server) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    instance.once("error", onError)
    instance.listen(endpoint, () => {
      instance.off("error", onError)
      resolve()
    })
  })
}

async function startServer() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  await restore()
  const instance = createServer(accept)
  try {
    await listen(instance)
  } catch (error) {
    const parsed = errnoSchema.safeParse(error)
    const code = parsed.success ? parsed.data.code : ""
    if (process.platform === "win32" || code !== "EADDRINUSE") throw error
    if (await probe(endpoint)) return
    await unlink(endpoint).catch(() => undefined)
    await listen(instance)
  }
  server = instance
  if (process.platform !== "win32") await chmod(endpoint, 0o600)
  setInterval(() => void persist(), 2_000)
}

async function shutdown(code: number) {
  if (stopping) return
  stopping = true
  await persist(true).catch(() => undefined)
  for (const client of clients) client.socket.destroy()
  server?.close()
  if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined)
  process.exit(code)
}

process.title = "mako-terminal-daemon"
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))
process.on("uncaughtException", () => void shutdown(1))
process.on("unhandledRejection", () => void shutdown(1))

void startServer().catch(() => void shutdown(1))
