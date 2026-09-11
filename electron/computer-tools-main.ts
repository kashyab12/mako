import { AppshotTargetSchema } from "./contracts/appshots.js"
import { verifyForegroundInput } from "./computer-input-target.js"
import { ComputerObservationClient } from "./computer-observation-client.js"
import { resolveDriverPaths } from "./computer-paths.js"
import {
  driverSchemaValidator,
  normalizeDriverSchema,
} from "./driver-schema.js"
import {
  ControlImageSchema,
  type ControlImage,
} from "./contracts/control-preview.js"
import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { parseArgs } from "node:util"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { isMainModule } from "./main-module.js"

const instructions = `Mako computer control operates native applications through a host-owned driver. Your task's session identity is supplied automatically and cannot collide with another task. Start with mako_computer_check_permissions (prompt:false), list_apps/list_windows to discover exact pid and window_id, then start_session to choose capture_scope (auto, window or desktop). Do not invent IDs or target a similarly named window.

Use get_window_state to obtain the accessibility tree AND a real screenshot of the exact window. Ground actions in fresh element_token values or screenshot coordinates. Prefer tokens over numeric indices; Mako remembers which pid and window_id produced each snapshot, so a token-addressed action needs no other identifiers. Reobserve after an action and verify its result; transport success alone is not proof that the UI changed. If accessibility fails, use the pixel route on the same observed window. Respect screenshot scale and frame metadata. A missing or stale window/token requires rediscovery, never fallback to another window.

Window-state results are kept compact: max_elements defaults to 300 and the duplicate tree_markdown rendering is omitted unless include_markdown is true. Use query to filter by label, max_elements:1 for a screenshot-only capture, or include_screenshot:false for a tree-only read. Electron and Chromium windows on macOS do not accept background scrolling; for pages inside a browser prefer Mako browser tools, and for other Electron apps observe, act through accessibility tokens, or ask for foreground delivery explicitly.

The native API preserves window-local input without moving the user's physical pointer where supported. Foreground and desktop actions are explicit. Foreground delivery is global input: it requires the exact window to already be frontmost, and Mako checks that before dispatch. Never escalate to foreground automatically after a background failure. Prefer set_value for a native editable accessibility element when typing cannot be delivered in the background, then verify the resulting field. If the target cannot accept background input, report that limitation rather than writing into another app. Use native dialogs, menu paths, keyboard, pointer, clipboard and window controls as needed. Do not repeat text based on delivered_chars alone: the driver can report zero even when the field received the full text. Independently inspect the field; if it already contains the intended text, continue without replay. Otherwise establish the exact missing suffix before typing. A timeout or cancellation does not prove that an action did not execute.

For browser pages prefer Mako browser tools: they share a persistent approved browser connection and provide DOM/AX observations, screenshots, flexible JavaScript and full CDP commands. Computer controls remain available for browser chrome, OS dialogs and pages whose visual/native interaction is needed. macOS permissions, Chrome debugging consent and provider tool approval are distinct. Capture images are forwarded as native MCP image blocks with their structured targeting metadata intact. Output and input file paths (screenshot_out_file, output_dir, destination_root, files) may be absolute, ~-rooted or relative to the working directory; Mako resolves symlinked parents such as /tmp before the driver inspects them.`
const toolInputSchema = z.object({
  properties: z.record(z.string(), z.json()).optional(),
  required: z.array(z.string()).optional(),
})
// Loose on purpose: the driver's own annotations and metadata pass through.
const toolResultSchema = z.looseObject({
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      })
    )
    .optional(),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
})
const snapshotSchema = z.object({
  snapshot_id: z.string().min(1),
  pid: z.number().int().positive(),
  window_id: z.number().int().positive(),
})
const captureFileSchema = z.object({
  screenshot_file_path: z.string().min(1),
  screenshot_mime_type: z.enum(["image/png", "image/jpeg"]).optional(),
})
const tokenSchema = z.string().regex(/^(s[0-9a-f]{8}):\d+$/)
const snapshotIdSchema = z.string().regex(/^s[0-9a-f]{8}$/)
const positiveInteger = z.number().int().positive()
const MAX_PREVIEW_FILE_BYTES = 6 * 1024 * 1024
const DEFAULT_MAX_ELEMENTS = 300
/** Keys the driver repeats in every window-state result that agents rarely need. */
const VERBOSE_WINDOW_STATE_KEYS = ["tree_markdown", "_note"]

export interface ComputerBackend {
  command: string
  args: string[]
}

/** Read a capture the agent asked the driver to write to disk, for the preview only. */
async function previewFromFile(
  path: string,
  mimeType: "image/png" | "image/jpeg" | undefined
): Promise<ControlImage | undefined> {
  try {
    if ((await stat(path)).size > MAX_PREVIEW_FILE_BYTES) return undefined
    const data = (await readFile(path)).toString("base64")
    return ControlImageSchema.parse({
      data,
      mimeType:
        mimeType ?? (/\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png"),
    })
  } catch {
    return undefined
  }
}

type StructuredContent = NonNullable<
  z.infer<typeof toolResultSchema>["structuredContent"]
>

function withoutKeys(
  value: StructuredContent,
  keys: readonly string[]
): StructuredContent {
  const next: StructuredContent = {}
  for (const [key, entry] of Object.entries(value))
    if (!keys.includes(key)) next[key] = entry
  return next
}

/**
 * The driver answers a window-state call twice: a Markdown tree in the text
 * block and the structured elements (plus the same tree again) in
 * structuredContent. Providers hand whichever they prefer to the model, so
 * unless Markdown was asked for, both become one compact JSON document.
 */
function compactWindowState(
  result: z.infer<typeof toolResultSchema>
): z.infer<typeof toolResultSchema> {
  if (!result.structuredContent) return result
  const structuredContent = withoutKeys(
    result.structuredContent,
    VERBOSE_WINDOW_STATE_KEYS
  )
  // Keep the driver's block order: the first text block becomes the JSON
  // document and any further text block is dropped.
  let replaced = false
  const content = (result.content ?? []).flatMap((block) => {
    if (block.type !== "text") return [block]
    if (replaced) return []
    replaced = true
    return [{ type: "text", text: JSON.stringify(structuredContent) }]
  })
  if (!replaced)
    content.unshift({ type: "text", text: JSON.stringify(structuredContent) })
  return { ...result, content, structuredContent }
}

export function createComputerToolsServer(
  backend?: ComputerBackend,
  taskId = process.env.MAKO_TASK_ID ?? randomUUID()
): Server {
  const observations = new ComputerObservationClient()
  let client = new Client({ name: "mako-computer-use", version: "2.0.0" })
  let closed = false
  let starting: Promise<Tool[]> | undefined
  // The driver binds a session to the MCP transport that created it, so a
  // reconnect must mint a fresh id; the task id keeps it distinct from others.
  let session = `mako-${taskId}-${randomUUID().slice(0, 8)}`
  // Snapshot ids stay valid across calls, but the driver still wants the pid
  // and window that produced them; remember both so a token is enough.
  const snapshots = new Map<string, { pid: number; window_id: number }>()
  const tools = () => {
    starting ??= (async () => {
      if (closed) throw new Error("Computer control connection is closed")
      if (!backend) return []
      const connection = new Client(
        { name: "mako-computer-use", version: "2.0.0" },
        { jsonSchemaValidator: driverSchemaValidator() }
      )
      client = connection
      session = `mako-${taskId}-${randomUUID().slice(0, 8)}`
      snapshots.clear()
      connection.onclose = () => {
        if (client === connection) starting = undefined
      }
      const transport = new StdioClientTransport({ ...backend, stderr: "pipe" })
      try {
        await connection.connect(transport)
        const result = await connection.listTools()
        return result.tools
      } catch (error) {
        await connection.close()
        await transport.close()
        throw error
      }
    })().catch((error) => {
      starting = undefined
      throw error
    })
    return starting
  }
  const rememberSnapshot = (
    structuredContent: z.infer<typeof toolResultSchema>["structuredContent"]
  ) => {
    const snapshot = snapshotSchema.safeParse(structuredContent)
    if (!snapshot.success) return
    if (snapshots.size >= 64) {
      const oldest = snapshots.keys().next().value
      if (oldest !== undefined) snapshots.delete(oldest)
    }
    snapshots.set(snapshot.data.snapshot_id, {
      pid: snapshot.data.pid,
      window_id: snapshot.data.window_id,
    })
  }
  class ComputerServer extends Server {
    override async close(): Promise<void> {
      closed = true
      observations.close()
      await super.close()
      await client.close()
    }
  }
  const server = new ComputerServer(
    { name: "mako-local-control", version: "2.0.0" },
    { capabilities: { tools: {} }, instructions }
  )
  server.onclose = () => {
    closed = true
    observations.close()
    void client.close()
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "mako_computer_status",
        description:
          "Report whether this MCP client is attached to Mako's native computer-control driver. Does not request OS permission.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      ...(await tools()).map((tool) => {
        const input = toolInputSchema.parse(tool.inputSchema)
        const properties = { ...input.properties }
        delete properties.session
        if (tool.name === "get_window_state")
          properties.include_markdown = {
            type: "boolean",
            description:
              "Include the driver's tree_markdown rendering of the same elements. Default false: the structured elements array carries every field, and the Markdown copy doubles the result size.",
          }
        return ToolSchema.parse({
          ...tool,
          outputSchema: tool.outputSchema
            ? normalizeDriverSchema(z.json().parse(tool.outputSchema))
            : undefined,
          name: `mako_computer_${tool.name}`,
          description:
            tool.name === "get_window_state"
              ? `${tool.description ?? ""}\n\nMako defaults max_elements to ${DEFAULT_MAX_ELEMENTS} and omits tree_markdown unless include_markdown is true. Pass max_elements:1 for a screenshot-only capture.`
              : tool.description,
          inputSchema: {
            ...tool.inputSchema,
            properties,
            required:
              input.required?.filter((name) => name !== "session") ?? [],
          },
        })
      }),
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name === "mako_computer_status")
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                available: Boolean(backend),
                tools: (await tools()).length,
              }),
            },
          ],
        }
      const tool = (await tools()).find(
        (tool) => `mako_computer_${tool.name}` === request.params.name
      )
      if (!tool)
        throw new Error("Computer tool is unavailable in this Mako session")
      const input = toolInputSchema.parse(tool.inputSchema)
      const args = await resolveDriverPaths({ ...request.params.arguments })
      delete args.session
      if (input.properties?.session) args.session = session
      const includeMarkdown = args.include_markdown === true
      delete args.include_markdown
      if (tool.name === "get_window_state" && args.max_elements === undefined)
        args.max_elements = DEFAULT_MAX_ELEMENTS
      const token = tokenSchema.safeParse(args.element_token)
      const snapshotId = token.success
        ? token.data.split(":")[0]
        : snapshotIdSchema.safeParse(args.snapshot_id).data
      const remembered = snapshotId ? snapshots.get(snapshotId) : undefined
      if (remembered) {
        if (
          input.properties?.pid &&
          !positiveInteger.safeParse(args.pid).success
        )
          args.pid = remembered.pid
        if (
          input.properties?.window_id &&
          !positiveInteger.safeParse(args.window_id).success
        )
          args.window_id = remembered.window_id
      }
      if (args.delivery_mode === "foreground" && input.properties?.pid)
        await verifyForegroundInput(client, args, extra.signal)
      const capturedWindow = AppshotTargetSchema.safeParse({
        pid: args.pid,
        windowId: args.window_id,
      }).data
      const target = `Window ${String(args.window_id ?? "selected")} · app ${String(args.pid ?? "selected")}`
      observations.submit({
        operation: tool.name,
        target,
        status: "running",
        window: capturedWindow,
      })
      const raw = toolResultSchema.parse(
        await client.callTool({ name: tool.name, arguments: args }, undefined, {
          signal: extra.signal,
          timeout: 60_000,
        })
      )
      if (tool.name === "get_window_state")
        rememberSnapshot(raw.structuredContent)
      const result =
        tool.name === "get_window_state" && !includeMarkdown
          ? compactWindowState(raw)
          : raw
      const inline = result.content?.find((block) => block.type === "image")
      const file = captureFileSchema.safeParse(result.structuredContent).data
      const image =
        ControlImageSchema.safeParse(inline).data ??
        (file
          ? await previewFromFile(
              file.screenshot_file_path,
              file.screenshot_mime_type
            )
          : undefined)
      observations.submit({
        operation: tool.name,
        target,
        status: result.isError ? "error" : "observed",
        image,
        window: capturedWindow,
      })
      return result
    } catch (error) {
      observations.submit({
        operation: request.params.name.replace(/^mako_computer_/, ""),
        target: "Selected application",
        status: "error",
      })
      const detail = {
        code: "computer-control-error",
        message:
          error instanceof Error ? error.message : "Computer operation failed",
        recovery:
          "Read the exact target again before deciding whether to repeat an action.",
      }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(detail) }],
        structuredContent: detail,
      }
    }
  })
  return server
}

export async function startComputerToolsServer(): Promise<void> {
  const { values } = parseArgs({
    options: { socket: { type: "string" }, driver: { type: "string" } },
  })
  const backend =
    values.socket && values.driver
      ? {
          command: values.driver,
          args: ["mcp", "--embedded", "--socket", values.socket],
        }
      : undefined
  const server = createComputerToolsServer(backend)
  const close = () => {
    void server.close()
  }
  process.stdin.once("end", close)
  process.once("SIGTERM", close)
  process.once("SIGINT", close)
  await server.connect(new StdioServerTransport())
}
if (isMainModule(import.meta.url))
  void startComputerToolsServer().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
