import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  BrowserCommandSchema,
  BrowserFault,
} from "./contracts/browser-control.js"
import { browserControlClient } from "./browser-control-client.js"
import {
  BrowserToolsRuntime,
  type BrowserCall,
} from "./browser-tools-runtime.js"
import { browserProtocolHelp } from "./browser-protocol-help.js"
import { isMainModule } from "./main-module.js"

const descriptions = {
  status:
    "Read browser connection state without connecting, prompting, or opening tabs. Browser IDs here identify the exact local browser installation.",
  connect:
    "Connect the selected browser once for this Mako host session. Chrome may ask for approval. Concurrent tasks join the same pending connection. Closing an MCP client does not disconnect Chrome.",
  tabs: "List existing page, iframe and worker targets in a connected browser, with identity, URL, title and whether a task has claimed them. Does not select or activate a tab.",
  open: "Create and claim a new tab in a connected browser. Background by default. Returns the exact target handle for all later calls.",
  select:
    "Claim the exact tab ID you inspected in tabs. Explicit takeover can transfer an idle tab from another task. Never selects a substitute or activates the tab.",
  release:
    "Release this task's exact tab binding. Leaves the tab and the shared Chrome connection open.",
  observe:
    "Read the exact tab's title, URL and bounded accessibility nodes. Fresh opaque refs can be used for clicking, typing or uploads. Observation replaces earlier refs for this tab.",
  screenshot:
    "Return an actual image plus its exact target identity. JPEG is the compact default; PNG and full-page capture are available. Does not change the selected target or reconnect.",
  evaluate:
    "Evaluate JavaScript in the exact tab and return the CDP result by value. Supports async expressions. May modify page state; use observations to read ordinary UI.",
  cdp: "Send a Chrome DevTools Protocol command to this exact target. Supports DOM, Runtime, Input, Network, Emulation, Page dialogs, downloads and other protocol domains. Browser/SystemInfo commands act on the browser. Target lifecycle uses open/select/release/close so ownership remains explicit. Use concurrent:true to answer a paused Fetch request or JavaScript dialog while another command is waiting. No failed command is replayed.",
  events:
    "Read a bounded, non-destructive event history for this exact tab. Pass the previous cursor; gap reports evicted history. Use cdp to enable needed domains, e.g. Network.enable. Page events are enabled automatically.",
  navigate:
    "Navigate this exact tab. By default waits for this navigation’s load event (up to 30 seconds); waitUntil:commit returns after navigation commits; reports same-document navigation or downloads separately. Observe afterwards to verify the result. Supports http, https and about URLs.",
  close:
    "Close this exact tab. Its old handle becomes invalid. Does not close Chrome or another task's tab.",
  click:
    "Click a fresh observation ref or exact viewport CSS coordinates in the bound tab. Ref clicks verify the element is present and not covered. Coordinates come from this tab's latest screenshot. Does not move the physical pointer.",
  type: "Insert text through Chrome's Input domain. An optional fresh ref focuses that exact element first. Without a ref, types into the already-focused element of this tab.",
  upload:
    "Set explicit absolute local file paths on an observed file-input ref in this exact tab. Empty files clears the input. This may upload file contents to the page.",
}
const toolDescriptions = new Map(Object.entries(descriptions))
const serializedInput = z.object({
  properties: z.record(z.string(), z.json()),
  required: z.array(z.string()).optional(),
})
const readActions = new Set([
  "status",
  "tabs",
  "observe",
  "screenshot",
  "events",
])
const instructions = `Mako browser control uses one host-owned Chrome connection across tasks. Start with mako_browser_status, connect the chosen browser if needed, then open a tab or inspect tabs and select an exact ID. Keep the returned {browser,tab,generation,lease} handle. Every later operation uses that handle; there is no implicit active tab. Switching providers in the same Mako task retains host bindings; rediscover handles if script state is gone. Page bindings enable focus emulation so hidden tabs receive real input without activating the physical tab; release disables it. Explicit CDP can change that emulation when testing focus-dependent behavior.

Use observe for accessible UI and fresh element refs; use screenshot for visual content and coordinate grounding. Cross-check UI changes after actions. A new observation invalidates earlier refs, and navigation invalidates them too. Never guess refs, tab IDs or coordinates. A target-closed or stale-target error requires explicit rediscovery, never choosing the first available tab. A cancelled/timed-out action may have completed; observe before deciding what to do next. The host refuses further mutations on an uncertain binding until it is observed.

For flexible workflows use mako_browser_exec with asynchronous JavaScript. browser.<action>({arguments}) has the same arguments as the matching MCP tool, excluding action. Await every call. state is a persistent object local to this MCP client. console.log emits text; emitImage(await browser.screenshot({target: state.tab})) emits a real image. Example: state.tab = await browser.open({browser:'chrome',url:'http://127.0.0.1:5173'}); console.log(await browser.observe({target:state.tab})); emitImage(await browser.screenshot({target:state.tab}));

Scripts run in a terminable local worker with a 60-second limit. They are trusted local JavaScript, not an OS sandbox. Return small results. Worker state resets after timeout/error; host tab bindings and the shared connection remain. Use mako_browser_help for protocol command schemas. CDP enables advanced network inspection, page evaluation, input, emulation, JavaScript dialogs, frame inspection and download configuration without requiring another browser runtime. Use explicit target lifecycle tools instead of raw Target mutations. For request interception or dialogs, enable the relevant domain first, read events, and use cdp with concurrent:true to unblock the pending operation; otherwise calls on one target are serialized.

For native windows, OS dialogs or content outside a browser page, use Mako computer tools. Browser connection approval is separate from macOS Accessibility/Screen Recording and provider tool approval. Local browser control never automatically switches to a hosted browser.`

export const BROWSER_TOOL_INPUTS = {
  exec: z.object({ source: z.string().min(1).max(100_000) }).strict(),
  help: z
    .object({ domain: z.string().optional(), method: z.string().optional() })
    .strict(),
}
const imageResult = z.object({
  data: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  target: z.json(),
  coordinates: z.json().optional(),
  clip: z.json().optional(),
})

export function createBrowserToolsServer(
  call: BrowserCall = browserControlClient()
): Server {
  const runtime = new BrowserToolsRuntime(call)
  class BrowserServer extends Server {
    override async close(): Promise<void> {
      await super.close()
      await runtime.close()
    }
  }
  const server = new BrowserServer(
    { name: "mako-browser-use", version: "2.0.0" },
    { capabilities: { tools: {}, logging: {} }, instructions }
  )
  server.onclose = () => {
    void runtime.close()
  }
  server.setRequestHandler(ListToolsRequestSchema, () =>
    ListToolsResultSchema.parse({
      tools: [
        ...BrowserCommandSchema.options.map((schema) => {
          const input = serializedInput.parse(z.toJSONSchema(schema))
          const action = z
            .object({ const: z.string() })
            .parse(input.properties.action).const
          delete input.properties.action
          const readOnly = readActions.has(action)
          return {
            name: `mako_browser_${action}`,
            description: toolDescriptions.get(action),
            inputSchema: {
              type: "object",
              properties: input.properties,
              required:
                input.required?.filter((name) => name !== "action") ?? [],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint:
                !readOnly &&
                !["connect", "open", "select", "release"].includes(action),
              idempotentHint:
                readOnly || ["connect", "release"].includes(action),
              openWorldHint: ![
                "status",
                "connect",
                "tabs",
                "select",
                "release",
                "events",
              ].includes(action),
            },
          }
        }),
        {
          name: "mako_browser_exec",
          description:
            "Run flexible async JavaScript with the documented browser API, persistent state, console.log and emitImage. Await all calls. Trusted local code; 60-second worker limit. Browser actions retain exact task ownership and are never replayed.",
          inputSchema: z.toJSONSchema(BROWSER_TOOL_INPUTS.exec),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        {
          name: "mako_browser_help",
          description:
            "Read installed Chrome protocol schemas. With no domain, lists domains. With a domain, lists commands/events; with method, returns that command and referenced domain types.",
          inputSchema: z.toJSONSchema(BROWSER_TOOL_INPUTS.help),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
    })
  )
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name === "mako_browser_exec") {
        const { source } = BROWSER_TOOL_INPUTS.exec.parse(
          request.params.arguments
        )
        return { content: await runtime.run(source, extra.signal) }
      }
      if (request.params.name === "mako_browser_help") {
        const args = BROWSER_TOOL_INPUTS.help.parse(request.params.arguments)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await browserProtocolHelp(args.domain, args.method)
              ),
            },
          ],
        }
      }
      const command = BrowserCommandSchema.parse({
        ...request.params.arguments,
        action: request.params.name.replace(/^mako_browser_/, ""),
      })
      const token = request.params._meta?.progressToken
      if (command.action === "connect" && token !== undefined)
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: 0,
            total: 1,
            message:
              "Connecting to Chrome. Approve its debugging connection if prompted; Mako will retain it across tasks.",
          },
        })
      const value = await call(command, extra.signal)
      if (command.action === "screenshot") {
        const image = imageResult.parse(value)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                target: image.target,
                coordinates: image.coordinates,
                clip: image.clip,
              }),
            },
            { type: "image", data: image.data, mimeType: image.mimeType },
          ],
          structuredContent: {
            target: image.target,
            coordinates: image.coordinates,
            clip: image.clip,
          },
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: { value },
      }
    } catch (error) {
      const fault =
        error instanceof BrowserFault
          ? error.detail
          : {
              code: "invalid-request",
              message:
                error instanceof Error
                  ? error.message
                  : "Browser operation failed",
              outcome: "unknown",
            }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(fault) }],
        structuredContent: fault,
      }
    }
  })
  return server
}

export async function startBrowserToolsServer(): Promise<void> {
  const server = createBrowserToolsServer()
  const close = () => {
    void server.close().catch(reportStartupFailure)
  }
  process.stdin.once("end", close)
  process.once("SIGTERM", close)
  process.once("SIGINT", close)
  await server.connect(new StdioServerTransport())
}
function reportStartupFailure(error: Error): void {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
if (isMainModule(import.meta.url))
  void startBrowserToolsServer().catch(reportStartupFailure)
