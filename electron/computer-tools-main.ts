import { AppshotTargetSchema } from "./contracts/appshots.js"
import { verifyForegroundInput } from "./computer-input-target.js"
import { ComputerObservationClient } from "./computer-observation-client.js"
import { ControlImageSchema } from "./contracts/control-preview.js"
import { randomUUID } from "node:crypto"
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

Use get_window_state to obtain the accessibility tree AND a real screenshot of the exact window. Ground actions in fresh element_token values or screenshot coordinates. Prefer tokens over numeric indices. Reobserve after an action and verify its result; transport success alone is not proof that the UI changed. If accessibility fails, use the pixel route on the same observed window. Respect screenshot scale and frame metadata. A missing or stale window/token requires rediscovery, never fallback to another window.

The native API preserves window-local input without moving the user's physical pointer where supported. Foreground and desktop actions are explicit. Foreground delivery is global input: it requires the exact window to already be frontmost, and Mako checks that before dispatch. Never escalate to foreground automatically after a background failure. Prefer set_value for a native editable accessibility element when typing cannot be delivered in the background, then verify the resulting field. If the target cannot accept background input, report that limitation rather than writing into another app. Use native dialogs, menu paths, keyboard, pointer, clipboard and window controls as needed. Do not repeat text based on delivered_chars alone: the driver can report zero even when the field received the full text. Independently inspect the field; if it already contains the intended text, continue without replay. Otherwise establish the exact missing suffix before typing. A timeout or cancellation does not prove that an action did not execute.

For browser pages prefer Mako browser tools: they share a persistent approved browser connection and provide DOM/AX observations, screenshots, flexible JavaScript and full CDP commands. Computer controls remain available for browser chrome, OS dialogs and pages whose visual/native interaction is needed. macOS permissions, Chrome debugging consent and provider tool approval are distinct. Capture images are forwarded as native MCP image blocks with their structured targeting metadata intact.`
const toolInputSchema = z.object({
  properties: z.record(z.string(), z.json()).optional(),
  required: z.array(z.string()).optional(),
})
export interface ComputerBackend {
  command: string
  args: string[]
}

export function createComputerToolsServer(
  backend?: ComputerBackend,
  taskId = process.env.MAKO_TASK_ID ?? randomUUID()
): Server {
  const observations = new ComputerObservationClient()
  let client = new Client({ name: "mako-computer-use", version: "2.0.0" })
  let closed = false
  let starting: Promise<Tool[]> | undefined
  const tools = () => {
    starting ??= (async () => {
      if (closed) throw new Error("Computer control connection is closed")
      if (!backend) return []
      const connection = new Client({
        name: "mako-computer-use",
        version: "2.0.0",
      })
      client = connection
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
        return ToolSchema.parse({
          ...tool,
          name: `mako_computer_${tool.name}`,
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
      const args = { ...request.params.arguments }
      delete args.session
      if (input.properties?.session) args.session = `mako-${taskId}`
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
      const result = await client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        { signal: extra.signal, timeout: 60_000 }
      )
      const content = z
        .object({
          content: z
            .array(
              z.object({
                type: z.string(),
                data: z.string().optional(),
                mimeType: z.string().optional(),
              })
            )
            .optional(),
          isError: z.boolean().optional(),
        })
        .parse(result)
      const image = content.content?.find((block) => block.type === "image")
      observations.submit({
        operation: tool.name,
        target,
        status: content.isError ? "error" : "observed",
        image: ControlImageSchema.safeParse(image).data,
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
