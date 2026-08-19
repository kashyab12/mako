import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import type {
  TerminalCreateOptions,
  TerminalEvent,
  TerminalSession,
  TerminalSnapshot,
} from "./shared.js"
import {
  JsonLineDecoder,
  TERMINAL_DAEMON_VERSION,
  TERMINAL_PROTOCOL_VERSION,
  encodeTerminalFrame,
  parseTerminalDaemonEvent,
  parseTerminalResponse,
  splitTerminalInput,
  type TerminalRequest,
  type TerminalResult,
  type TerminalWireValue,
} from "./terminal-protocol.js"

interface PendingRequest {
  resolve: (result: TerminalResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export function terminalEndpoint(stateDir: string) {
  if (process.platform !== "win32") return join(stateDir, "daemon.sock")
  const owner = createHash("sha256").update(stateDir).digest("hex").slice(0, 20)
  return `\\\\.\\pipe\\mako-terminal-${owner}`
}

export class TerminalDaemonClient {
  readonly #endpoint: string
  readonly #pending = new Map<number, PendingRequest>()
  #socket: Socket | null = null
  #decoder = new JsonLineDecoder()
  #connectPromise: Promise<void> | null = null
  #reconnectTimer: NodeJS.Timeout | null = null
  #nextId = 1
  #disposed = false
  #attachedSessionId?: string
  readonly #daemonEntry: string
  readonly #stateDir: string
  readonly #emit: (event: TerminalEvent) => void

  constructor(
    daemonEntry: string,
    stateDir: string,
    emit: (event: TerminalEvent) => void
  ) {
    this.#daemonEntry = daemonEntry
    this.#stateDir = stateDir
    this.#emit = emit
    this.#endpoint = terminalEndpoint(stateDir)
  }

  async list(): Promise<TerminalSession[]> {
    const result = await this.#request({ id: this.#id(), type: "list" })
    if (result.kind !== "sessions") throw new Error("Terminal daemon returned an invalid session list")
    return result.sessions
  }

  async create(options: TerminalCreateOptions): Promise<TerminalSession> {
    const result = await this.#request({ id: this.#id(), type: "create", ...options })
    if (result.kind !== "session") throw new Error("Terminal daemon returned an invalid session")
    return result.session
  }

  async attach(sessionId: string): Promise<TerminalSnapshot> {
    this.#attachedSessionId = sessionId
    const result = await this.#request({ id: this.#id(), type: "attach", sessionId })
    if (result.kind !== "snapshot") throw new Error("Terminal daemon returned an invalid snapshot")
    return result.snapshot
  }

  async write(sessionId: string, data: string) {
    for (const chunk of splitTerminalInput(data)) {
      await this.#expectOk({
        id: this.#id(),
        type: "write",
        sessionId,
        data: chunk,
      })
    }
  }

  async resize(sessionId: string, cols: number, rows: number) {
    await this.#expectOk({ id: this.#id(), type: "resize", sessionId, cols, rows })
  }

  async kill(sessionId: string) {
    if (this.#attachedSessionId === sessionId) this.#attachedSessionId = undefined
    await this.#expectOk({ id: this.#id(), type: "kill", sessionId })
  }

  dispose() {
    this.#disposed = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
    this.#socket?.destroy()
    this.#socket = null
    this.#rejectPending(new Error("Terminal client stopped"))
  }

  #id() {
    return this.#nextId++
  }

  async #expectOk(request: TerminalRequest) {
    const result = await this.#request(request)
    if (result.kind !== "ok") throw new Error("Terminal daemon rejected the operation")
  }

  async #request(request: TerminalRequest) {
    await this.#ensureConnected()
    return this.#requestConnected(request)
  }

  #requestConnected(request: TerminalRequest) {
    const socket = this.#socket
    if (!socket || socket.destroyed) return Promise.reject(new Error("Terminal daemon is disconnected"))
    return new Promise<TerminalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id)
        reject(new Error("Terminal daemon did not answer within 10 seconds"))
      }, 10_000)
      this.#pending.set(request.id, { resolve, reject, timer })
      socket.write(encodeTerminalFrame(request))
    })
  }

  #ensureConnected() {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve()
    if (this.#disposed) return Promise.reject(new Error("Terminal client stopped"))
    this.#connectPromise ??= this.#connect().finally(() => {
      this.#connectPromise = null
    })
    return this.#connectPromise
  }

  async #connect() {
    this.#emit({ type: "connection", state: "connecting" })
    await mkdir(this.#stateDir, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") await chmod(this.#stateDir, 0o700)
    let socket = await this.#tryOpen()
    if (!socket) {
      this.#spawnDaemon()
      for (let attempt = 0; attempt < 30 && !socket; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        socket = await this.#tryOpen()
      }
    }
    if (!socket) {
      const error = new Error("The local terminal daemon could not be started")
      this.#emit({ type: "connection", state: "disconnected", error: error.message })
      this.#scheduleReconnect()
      throw error
    }
    this.#adopt(socket)
    try {
      const hello = await this.#requestConnected({
        protocol: TERMINAL_PROTOCOL_VERSION,
        id: this.#id(),
        type: "hello",
        clientVersion: TERMINAL_DAEMON_VERSION,
      })
      if (hello.kind !== "hello") throw new Error("Terminal daemon handshake failed")
      if (hello.daemonVersion !== TERMINAL_DAEMON_VERSION) {
        await this.#expectOk({
          protocol: TERMINAL_PROTOCOL_VERSION,
          id: this.#id(),
          type: "replace",
        })
        socket.destroy()
        this.#spawnDaemon()
        throw new Error("Replacing an outdated terminal daemon")
      }
      this.#emit({ type: "connection", state: "ready" })
      if (this.#attachedSessionId) {
        const result = await this.#requestConnected({
          id: this.#id(),
          type: "attach",
          sessionId: this.#attachedSessionId,
        })
        if (result.kind === "snapshot") this.#emit({ type: "snapshot", snapshot: result.snapshot })
      }
    } catch (error) {
      socket.destroy()
      this.#scheduleReconnect()
      throw error
    }
  }

  #tryOpen() {
    return new Promise<Socket | null>((resolve) => {
      const socket = createConnection(this.#endpoint)
      socket.once("connect", () => resolve(socket))
      socket.once("error", () => {
        socket.destroy()
        resolve(null)
      })
    })
  }

  #spawnDaemon() {
    const child = spawn(
      process.execPath,
      [this.#daemonEntry, "--endpoint", this.#endpoint, "--state-dir", this.#stateDir],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      }
    )
    child.unref()
  }

  #adopt(socket: Socket) {
    this.#socket = socket
    this.#decoder = new JsonLineDecoder()
    socket.setNoDelay(true)
    socket.on("data", (chunk) => {
      try {
        for (const value of this.#decoder.push(chunk)) this.#receive(value)
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on("close", () => this.#disconnected(socket))
    socket.on("error", () => this.#disconnected(socket))
  }

  #receive(value: TerminalWireValue) {
    const response = parseTerminalResponse(value)
    if (response) {
      const pending = this.#pending.get(response.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.#pending.delete(response.id)
      if (response.ok && response.result) pending.resolve(response.result)
      else pending.reject(new Error(response.error ?? "Terminal daemon request failed"))
      return
    }
    const event = parseTerminalDaemonEvent(value)
    if (!event) return
    if (event.type === "output") {
      this.#emit({
        type: "output",
        sessionId: event.sessionId,
        sequence: event.sequence,
        data: event.data,
      })
    } else if (event.type === "status") {
      this.#emit({ type: "status", session: event.session })
    } else {
      this.#emit({ type: "removed", sessionId: event.sessionId })
    }
  }

  #disconnected(socket: Socket) {
    if (this.#socket !== socket) return
    this.#socket = null
    this.#rejectPending(new Error("Terminal daemon disconnected"))
    if (this.#disposed) return
    this.#emit({ type: "connection", state: "disconnected" })
    this.#scheduleReconnect()
  }

  #rejectPending(error: Error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #scheduleReconnect() {
    if (this.#disposed || this.#reconnectTimer) return
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#ensureConnected().catch(() => undefined)
    }, 500)
  }
}
