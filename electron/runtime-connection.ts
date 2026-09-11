import { request } from "node:http"
import { StringDecoder } from "node:string_decoder"
import { RuntimeCallSchema, RuntimeInfoSchema, RuntimePacketSchema, RuntimeReplySchema, type RuntimeCall } from "./contracts/runtime.js"
import type { z } from "zod"

interface RuntimeRequest<Schema extends z.ZodType> {
  socket: string
  path: string
  schema: Schema
  body?: RuntimeCall
  client?: string
  timeoutMs?: number
}

export async function runtimeRequest<Schema extends z.ZodType>({ socket, path, schema, body, client, timeoutMs = 45_000 }: RuntimeRequest<Schema>): Promise<z.output<Schema>> {
  return new Promise((resolve, reject) => {
    const headers = new Map([["content-type", "application/json"]])
    if (client) headers.set("x-mako-window", client)
    const req = request({ socketPath: socket, path, method: body === undefined ? "GET" : "POST", headers: Object.fromEntries(headers) }, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 32 * 1024 * 1024) response.destroy(new Error("Mako host response exceeded its limit"))
        else chunks.push(chunk)
      })
      response.on("error", reject)
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Mako host returned ${response.statusCode}`)
          resolve(schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Mako host request timed out")))
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export async function runtimeInfo(socket: string) {
  try { return await runtimeRequest({ socket, path: "/health", schema: RuntimeInfoSchema, timeoutMs: 10_000 }) }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) return null
    throw error
  }
}

export async function invokeRuntime(socket: string, client: string, channel: string, args: unknown[]) {
  const encoded = JSON.stringify({ channel, args: args.map((value) => value === undefined ? { kind: "absent" } : { kind: "value", value }) })
  const body = RuntimeCallSchema.parse(JSON.parse(encoded))
  const reply = await runtimeRequest({ socket, path: "/rpc", schema: RuntimeReplySchema, body, client, timeoutMs: 5 * 60_000 })
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}

export function subscribeRuntime(socket: string, client: string, receive: (packet: z.infer<typeof RuntimePacketSchema>) => void, disconnected: () => void) {
  let closed = false
  let ended = false
  const end = () => { if (!ended && !closed) { ended = true; disconnected() } }
  const req = request({ socketPath: socket, path: "/events", method: "POST", headers: { "x-mako-window": client } }, (response) => {
    const decoder = new StringDecoder("utf8")
    let pending = ""
    if (response.statusCode !== 200) { response.destroy(); end(); return }
    response.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk)
      if (pending.length > 32 * 1024 * 1024) { response.destroy(); end(); return }
      for (;;) {
        const newline = pending.indexOf("\n")
        if (newline < 0) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line.trim()) continue
        try { receive(RuntimePacketSchema.parse(JSON.parse(line))) }
        catch { response.destroy(); end(); return }
      }
    })
    response.on("error", end)
    response.on("end", end)
    response.on("close", end)
  })
  req.on("error", end)
  req.end()
  return () => { closed = true; req.destroy() }
}

export function runtimeFile(socket: string, input: Request): Promise<Response> {
  const url = new URL(input.url)
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: `/file/${url.hostname}${url.pathname}${url.search}`, headers: input.headers.has("range") ? { range: input.headers.get("range") ?? "" } : {} }, (response) => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Buffer) => { controller.enqueue(chunk); response.pause() })
          response.on("end", () => controller.close())
          response.on("error", (error) => controller.error(error))
        },
        pull() { response.resume() },
        cancel() { response.destroy(); req.destroy() },
      })
      resolve(new Response(body, { status: response.statusCode ?? 502, headers }))
    })
    req.on("error", reject)
    input.signal.addEventListener("abort", () => req.destroy(), { once: true })
    req.end()
  })
}
