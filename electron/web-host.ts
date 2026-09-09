import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { once } from "node:events"
import { chmod } from "node:fs/promises"
import { z } from "zod"
import type { HostEvent, TerminalEvent } from "./shared.js"
import type { RuntimeInfo } from "./contracts/runtime.js"

const argument = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("value"), value: z.json() }),
])
const requestSchema = z
  .object({
    channel: z.string().regex(/^mako:[a-z0-9-]+$/),
    args: z.array(argument).max(32),
  })
  .strict()
async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 32 * 1024 * 1024)
      throw new Error("Mako web request exceeds 32 MB")
    chunks.push(buffer)
  }
  return requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}

/** Development-only host transport on a private Unix socket, never a public TCP listener. */
export async function startWebHost(
  socket: string,
  invoke: (channel: string, args: unknown[], client?: string) => Promise<string>,
  file: (request: Request) => Promise<Response>,
  disconnected?: (client: string) => void,
  runtime?: RuntimeInfo
) {
  const streams = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store")
    if (request.method === "GET" && request.url === "/health" && runtime) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(runtime))
      return
    }
    if (request.method === "GET" && request.url?.startsWith("/file/")) {
      const abort = new AbortController()
      response.once("close", () => abort.abort())
      const headers = new Headers()
      if (request.headers.range) headers.set("range", request.headers.range)
      const url = `mako-file://${request.url.slice("/file/".length)}`
      void Promise.resolve()
        .then(() => file(new Request(url, { headers, signal: abort.signal })))
        .then(async (result) => {
          response.writeHead(result.status, {
            ...Object.fromEntries(result.headers),
            "content-security-policy": "sandbox; default-src 'none'",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          })
          if (result.body)
            for await (const chunk of result.body) {
              if (!response.write(chunk))
                await once(response, "drain", { signal: abort.signal })
            }
          response.end()
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(404)
          response.end()
        })
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    const client = z.string().uuid().optional().safeParse(request.headers["x-mako-window"])
    if (!client.success) {
      response.writeHead(400).end("Invalid workspace client")
      return
    }
    const clientId = client.data ? `web:${client.data}` : "web"
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "application/x-ndjson" })
      response.write(JSON.stringify({ channel: "ready" }) + "\n")
      streams.add(response)
      response.once("close", () => {
        streams.delete(response)
        if (client.data) disconnected?.(clientId)
      })
      return
    }
    if (request.url !== "/rpc") {
      response.writeHead(404).end()
      return
    }
    void readRequest(request)
      .then(async ({ channel, args }) => {
        const encoded = await invoke(
          channel,
          args.map((arg) => (arg.kind === "absent" ? undefined : arg.value)),
          clientId
        )
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(encoded)
      })
      .catch((error) => {
        if (!response.destroyed)
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Mako host request failed",
            })
          )
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  await chmod(socket, 0o600)
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write("\n")
  }, 15_000)
  heartbeat.unref()
  const send = (
    channel: "event" | "terminal",
    payload: HostEvent | TerminalEvent
  ) => {
    const line = JSON.stringify({ channel, payload }) + "\n"
    for (const stream of streams) {
      if (stream.writableLength > 8 * 1024 * 1024)
        stream.destroy(new Error("Web client stopped consuming host events"))
      else stream.write(line)
    }
  }
  return {
    event: (event: HostEvent) => send("event", event),
    terminal: (event: TerminalEvent) => send("terminal", event),
    close() {
      clearInterval(heartbeat)
      for (const stream of streams) stream.end()
      streams.clear()
      server.closeAllConnections()
      server.close()
    },
  }
}
