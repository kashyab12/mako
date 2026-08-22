import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import type { JsonObject } from "../codex-app-json.js"

interface RpcOutbound {
  id?: number
  method: string
  params: object
}

interface RpcInbound<TResult> {
  id?: number
  result: TResult
  error?: { message?: string }
}

export async function readJson<TResult>(path: string): Promise<TResult | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

export function runDiscovery(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    const stdoutDecoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`${command} discovery timed out`))
    }, 10_000)
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + stdoutDecoder.write(chunk)).slice(-8_000_000)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + stderrDecoder.write(chunk)).slice(-4_000)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      clearTimeout(timer)
      stdout = (stdout + stdoutDecoder.end()).slice(-8_000_000)
      stderr = (stderr + stderrDecoder.end()).slice(-4_000)
      if (code === 0) resolve(stdout)
      else
        reject(
          new Error(
            stderr.trim().split("\n").at(-1) ||
              `${command} exited with ${code}`
          )
        )
    })
    child.stdin?.end(input)
  })
}

export function streamRequest<TMessage, TResult>(
  command: string,
  args: string[],
  request: JsonObject,
  env: NodeJS.ProcessEnv,
  pick: (value: TMessage) => TResult | undefined
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    let settled = false
    const finish = (value: TResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGTERM")
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error(`${command} discovery timed out`))
    }, 10_000)
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const message: TMessage = JSON.parse(line)
          const selected = pick(message)
          if (selected !== undefined) finish(selected)
        } catch {
          continue
        }
      }
    })
    child.on("error", reject)
    child.stdin?.end(`${JSON.stringify(request)}\n`)
  })
}

export function rpcRequest<TResult>(
  command: string,
  args: string[],
  method: string,
  env: NodeJS.ProcessEnv,
  jsonrpc: boolean
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    const decoder = new StringDecoder("utf8")
    let buffer = ""
    let initialized = false
    let settled = false
    const envelope = (value: RpcOutbound) =>
      jsonrpc ? { jsonrpc: "2.0", ...value } : value
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error(`${command} protocol discovery timed out`))
    }, 10_000)
    const send = (value: RpcOutbound) =>
      child.stdin?.write(`${JSON.stringify(envelope(value))}\n`)
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const message: RpcInbound<TResult> = JSON.parse(line)
          if (message.id === 1 && !initialized) {
            if (message.error)
              throw new Error(message.error.message ?? "initialize failed")
            initialized = true
            send({ method: "initialized", params: {} })
            send({ id: 2, method, params: {} })
          } else if (message.id === 2) {
            settled = true
            clearTimeout(timer)
            child.kill("SIGTERM")
            if (message.error)
              reject(new Error(message.error.message ?? `${method} failed`))
            else resolve(message.result)
          }
        } catch (error) {
          if (
            !settled &&
            error instanceof Error &&
            error.message.includes("failed")
          )
            reject(error)
        }
      }
    })
    child.on("error", reject)
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
        capabilities: { experimentalApi: true },
      },
    })
  })
}
