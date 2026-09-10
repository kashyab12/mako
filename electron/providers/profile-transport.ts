import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../codex-app-json.js"
import { withDiscoveryProcess } from "./discovery-process.js"

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
  input?: string,
  cwd?: string
): Promise<string> {
  return withDiscoveryProcess(
    { command, args, env, cwd },
    async ({ child, exited }) => {
      const chunks: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.stdin.end(input)
      const result = await exited
      if (result.code !== 0)
        throw new Error(
          `${command} discovery exited with ${result.signal ?? result.code}`
        )
      return Buffer.concat(chunks).toString("utf8")
    }
  )
}

export function streamRequest<TResult>(
  command: string,
  args: string[],
  request: JsonObject,
  env: NodeJS.ProcessEnv,
  pick: (value: JsonValue) => TResult | undefined,
  cwd?: string,
  priority: Parameters<
    typeof withDiscoveryProcess
  >[0]["priority"] = "background"
): Promise<TResult> {
  return withDiscoveryProcess(
    { command, args, env, cwd, priority },
    async ({ child, exited, phase }) => {
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })
      try {
        return await new Promise<TResult>((resolve, reject) => {
          lines.on("line", (line) => {
            let message: JsonValue
            try {
              message = z.json().parse(JSON.parse(line))
            } catch {
              return
            }
            try {
              const selected = pick(message)
              if (selected !== undefined) resolve(selected)
            } catch {
              reject(
                new Error(`${command} returned an invalid discovery response`)
              )
            }
          })
          phase("control response")
          child.stdin.end(`${JSON.stringify(request)}\n`)
          void exited.then(({ code, signal }) =>
            reject(
              new Error(
                `${command} exited with ${signal ?? code} before discovery completed`
              )
            )
          )
        })
      } finally {
        lines.close()
      }
    }
  )
}

const RpcResponseSchema = z.object({
  id: z.number(),
  result: z.json().optional(),
  error: z.object({ code: z.number().optional() }).optional(),
})

export function rpcRequest(
  command: string,
  args: string[],
  method: string,
  env: NodeJS.ProcessEnv,
  jsonrpc: boolean,
  params: JsonObject = {},
  cwd?: string
): Promise<JsonValue> {
  return withDiscoveryProcess(
    { command, args, env, cwd },
    async ({ child, exited, phase }) => {
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })
      try {
        return await new Promise<JsonValue>((resolve, reject) => {
          let initialized = false
          const send = (message: {
            id?: number
            method: string
            params: object
          }) => {
            child.stdin.write(
              `${JSON.stringify(jsonrpc ? { jsonrpc: "2.0", ...message } : message)}\n`
            )
          }
          lines.on("line", (line) => {
            let value: unknown
            try {
              value = JSON.parse(line)
            } catch {
              return
            }
            const parsed = RpcResponseSchema.safeParse(value)
            if (!parsed.success || ![1, 2].includes(parsed.data.id)) return
            const message = parsed.data
            if (message.error) {
              reject(
                new Error(
                  `${command} ${message.id === 1 ? "initialize" : method} failed (RPC ${message.error.code ?? "error"})`
                )
              )
              return
            }
            if (message.result === undefined) {
              reject(
                new Error(
                  `${command} returned a discovery response without a result`
                )
              )
              return
            }
            if (message.id === 1 && !initialized) {
              initialized = true
              phase(method)
              send({ method: "initialized", params: {} })
              send({ id: 2, method, params })
            } else if (message.id === 2 && initialized) resolve(message.result)
          })
          phase("initialize")
          send({
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 1,
              clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
              clientCapabilities: {
                session: { configOptions: { boolean: {} } },
              },
              capabilities: { experimentalApi: true },
            },
          })
          void exited.then(({ code, signal }) =>
            reject(
              new Error(
                `${command} exited with ${signal ?? code} before ${method} discovery completed`
              )
            )
          )
        })
      } finally {
        lines.close()
      }
    }
  )
}
