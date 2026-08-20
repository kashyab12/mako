import { createConnection } from "node:net"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { JsonObject } from "./codex-app-json.js"

const MAX_OUTPUT = 2 * 1024 * 1024
const TIMEOUT = 20_000

export const PREVIEW_TOOL_INPUTS = {
  previewList: z.object({}).strict(),
  previewState: z.object({ id: z.string().min(1).max(80) }).strict(),
  previewNavigate: z
    .object({ id: z.string().min(1).max(80), url: z.url() })
    .strict(),
  previewSnapshot: z.object({ id: z.string().min(1).max(80) }).strict(),
  previewEvaluate: z
    .object({
      id: z.string().min(1).max(80),
      expression: z.string().min(1).max(100_000),
    })
    .strict(),
  previewClick: z
    .object({
      id: z.string().min(1).max(80),
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .strict(),
  previewType: z
    .object({
      id: z.string().min(1).max(80),
      text: z.string().max(100_000),
    })
    .strict(),
  previewPress: z
    .object({
      id: z.string().min(1).max(80),
      key: z.string().min(1).max(64),
    })
    .strict(),
} as const

const PreviewResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.json() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

function previewRequest(
  request: JsonObject,
  signal: AbortSignal
): Promise<string> {
  const path = process.env.MAKO_PREVIEW_SOCKET
  const token = process.env.MAKO_PREVIEW_TOKEN
  if (!path || !token) {
    return Promise.reject(new Error("Mako Preview control is not ready"))
  }
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(path)
    let output = ""
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      socket.destroy()
      if (error) {
        reject(error)
        return
      }
      try {
        const parsed = PreviewResponseSchema.parse(JSON.parse(output.trim()))
        if (!parsed.ok) throw new Error(parsed.error)
        resolveResult(JSON.stringify(parsed.result, null, 2))
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
    const onAbort = () => finish(new Error("Tool call was cancelled"))
    const timer = setTimeout(
      () => finish(new Error("Mako Preview timed out")),
      TIMEOUT
    )
    signal.addEventListener("abort", onAbort, { once: true })
    socket.setEncoding("utf8")
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ token, request })}\n`)
    )
    socket.on("data", (chunk: string) => {
      output += chunk
      if (output.length > MAX_OUTPUT) {
        finish(new Error("Mako Preview response exceeded the 2 MB limit"))
      }
    })
    socket.on("end", () => finish())
    socket.on("error", (error) => finish(error))
  })
}

function safeResult(run: () => Promise<string>) {
  return run().then(
    (text) => ({ content: [{ type: "text" as const, text }] }),
    (error: Error) => ({
      content: [{ type: "text" as const, text: error.message }],
      isError: true,
    })
  )
}

export function registerPreviewTools(server: McpServer): void {
  server.registerTool(
    "mako_preview_list",
    {
      description:
        "List live local Mako Preview tabs. These are isolated app previews, not the user's personal browser.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewList,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_args, extra) =>
      safeResult(() => previewRequest({ action: "list" }, extra.signal))
  )
  server.registerTool(
    "mako_preview_state",
    {
      description: "Read the URL, title, and loading state of one Mako Preview.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewState,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }, extra) =>
      safeResult(() => previewRequest({ action: "state", id }, extra.signal))
  )
  server.registerTool(
    "mako_preview_snapshot",
    {
      description:
        "Read bounded page text and interactive elements from one Mako Preview through CDP.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewSnapshot,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }, extra) =>
      safeResult(() => previewRequest({ action: "snapshot", id }, extra.signal))
  )
  server.registerTool(
    "mako_preview_navigate",
    {
      description:
        "Navigate one isolated local Mako Preview to an HTTP or HTTPS URL.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewNavigate,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ id, url }, extra) =>
      safeResult(() =>
        previewRequest({ action: "navigate", id, url }, extra.signal)
      )
  )
  server.registerTool(
    "mako_preview_click",
    {
      description:
        "Click viewport coordinates in one isolated Mako Preview through CDP without moving the system pointer.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewClick,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ id, x, y }, extra) =>
      safeResult(() =>
        previewRequest({ action: "click", id, x, y }, extra.signal)
      )
  )
  server.registerTool(
    "mako_preview_type",
    {
      description:
        "Insert text into the focused field in one isolated Mako Preview through CDP.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewType,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ id, text }, extra) =>
      safeResult(() =>
        previewRequest({ action: "type", id, text }, extra.signal)
      )
  )
  server.registerTool(
    "mako_preview_press",
    {
      description:
        "Send one key to the focused element in an isolated Mako Preview through CDP.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewPress,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ id, key }, extra) =>
      safeResult(() =>
        previewRequest({ action: "press", id, key }, extra.signal)
      )
  )
  server.registerTool(
    "mako_preview_evaluate",
    {
      description:
        "Evaluate bounded JavaScript in one isolated Mako Preview through CDP and return its value.",
      inputSchema: PREVIEW_TOOL_INPUTS.previewEvaluate,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ id, expression }, extra) =>
      safeResult(() =>
        previewRequest({ action: "evaluate", id, expression }, extra.signal)
      )
  )
}
