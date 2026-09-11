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
    'Read browser connection state without connecting, prompting, or opening tabs. Browser IDs identify connected extension profiles, plus "mako" for hidden windows of Mako\'s own interface. Only the mako entry means no Chrome profile has the Mako Browser extension connected yet.',
  connect:
    "Connect the selected browser profile through its installed Mako Browser extension. Installation grants browser access; ordinary reconnects do not require another debugging approval. Concurrent tasks join the same pending connection. Closing an MCP client does not disconnect Chrome.",
  tabs: "List existing page, iframe and worker targets in a connected browser, with identity, URL, title, whether it is selectable as a page, and whether a task has claimed it. Does not select or activate a tab.",
  open: "Create and claim a new tab in a connected browser. Background by default. Returns the exact target handle for all later calls plus the navigation outcome; a failed navigation still returns the handle.",
  select:
    "Claim the exact tab ID you inspected in tabs. Explicit takeover can transfer an idle tab from another task. Never selects a substitute or activates the tab.",
  release:
    "Release this task's exact tab binding. Leaves the tab and the shared Chrome connection open.",
  observe:
    "Read the exact tab's title, URL, viewport scroll position and accessibility nodes within a 60 KB budget. Each node carries depth, role, name, value and live states (checked, disabled, focused, expanded, selected, required, pressed, level, url). Fresh refs address elements for click, type, press, hover, scroll, screenshot and upload; a new observation or navigation replaces them. Use interactiveOnly to see just controls, query to filter by text, and offset with nextOffset to page through a large tree.",
  screenshot:
    "Return an actual image plus its exact target identity and coordinate mapping. JPEG is the compact default; the longest side is 1568 px unless maxSide says otherwise; PNG, full-page and element-scoped (ref) captures are available. Does not change the selected target or reconnect.",
  evaluate:
    "Evaluate JavaScript in the exact tab and return the CDP result by value. Supports async expressions. May modify page state; use observations to read ordinary UI. For user interaction, use click/type/press: DOM click(), submit(), and dispatchEvent() do not produce trusted user input. Results over 200 KB are truncated with their size reported.",
  cdp: "Send a Chrome DevTools Protocol command to this exact target. Supports DOM, Runtime, Input, Network, Emulation, Page dialogs and other permitted protocol domains. Chrome extensions do not expose Browser/SystemInfo commands; those require an explicitly configured direct-CDP transport. Target lifecycle uses open/select/release/close so ownership remains explicit. Use concurrent:true to answer a paused Fetch request or JavaScript dialog while another command is waiting. No failed command is replayed.",
  events:
    "Read a bounded, non-destructive event history for this exact tab: at most limit events (default 32) within 60 KB. Pass the returned cursor as after to continue; more reports remaining events and gap reports evicted history. Use cdp to enable needed domains, e.g. Network.enable. Page events are enabled automatically.",
  navigate:
    "Navigate this exact tab. By default waits for this navigation’s load event (up to timeoutMs, default 30 seconds); waitUntil:domcontentloaded returns earlier and waitUntil:commit returns once the navigation is accepted. A redirect counts as the same navigation. Expiry returns completion:timeout rather than failing; observe afterwards to verify the result. Supports http, https, about and data URLs.",
  close:
    "Close this exact tab. Its old handle becomes invalid. Does not close Chrome or another task's tab.",
  click:
    'Click a fresh observation ref or exact viewport CSS coordinates in the bound tab. Ref clicks scroll the element into view and verify it is present and not covered. Pass at as an object, for example {"ref":"observed-ref"} or {"x":100,"y":200}, never a JSON-encoded string. Coordinates come from this tab\'s latest screenshot. Sends a real pointer move, press and release; count:2 double-clicks; modifiers hold keys. Does not move the physical pointer.',
  hover:
    "Move the pointer over a ref or viewport coordinates without pressing, to open hover menus and tooltips. Observe or screenshot afterwards to see the result.",
  scroll:
    "Scroll with a real wheel event at a ref, at viewport coordinates, or at the viewport centre. Positive deltaY scrolls down. Returns the resulting window scroll position; observe or screenshot afterwards to read the new content.",
  type: "Insert text through Chrome's Input domain. With ref, focuses that exact editable element first and reports its tag; without ref, types into the tab's focused element and refuses when nothing editable is focused. clear:true removes the field's current content first; submit:true presses Enter afterwards.",
  press:
    'Press one key with optional modifiers: a printable character such as "a" or "/", or Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, PageUp, PageDown, Space, F1-F12. Sends real key down and up events. An optional ref receives focus first.',
  upload:
    "Set explicit absolute local file paths on an observed file-input ref in this exact tab. Empty files clears the input. This may upload file contents to the page.",
  dialog:
    "Read, answer, or set policy for JavaScript dialogs (alert, confirm, prompt, beforeunload) on this tab. An open dialog blocks every other action until answered; respond accept or dismiss, with promptText for prompts. auto:accept or auto:dismiss answers future dialogs immediately and records them in events; auto:ask (default) leaves them for you.",
  download:
    "Save one file download into an existing absolute directory. Start it by clicking at a ref or coordinates, or by requesting a url, then wait until the browser reports completion. Returns the suggested filename, path and size; the browser may rename a clashing file.",
  pdf: "Print the current document to a PDF at an absolute local path. Options: landscape, printBackground, scale, paper size in inches, page ranges.",
  cookies:
    "List, set, delete, or clear cookies through this tab's session. list returns names, domains, paths, expiry and flags for the tab's URL (or urls); values are included only with includeValues:true. clear removes every cookie in the browser profile.",
  frames:
    "List the tab's frame tree: id, parent, url, name, origin and depth. Same-process frames accept frameId on observe and evaluate; out-of-process iframes are their own targets in tabs.",
  wait: "Wait up to timeoutMs for conditions: a CSS selector, body text, a URL substring, or network idle (no requests in flight for 500 ms). hidden inverts selector and text. Returns satisfied true or false with the elapsed time instead of failing.",
  history:
    "Go back or forward in this tab's history, or reload, and wait up to ten seconds for the load event. Reports whether the tab moved and its resulting URL.",
  selectOption:
    "Choose an option in an observed <select> by value or label and fire its input and change events. Lists the available options when nothing matches.",
}
const toolDescriptions = new Map(Object.entries(descriptions))
const serializedInput = z.object({
  properties: z.record(z.string(), z.json()),
  required: z.array(z.string()).optional(),
  $defs: z.record(z.string(), z.json()).optional(),
})
const readActions = new Set([
  "status",
  "tabs",
  "observe",
  "screenshot",
  "events",
  "frames",
  "wait",
])
/** Text results above this many bytes are cut down to a preview. */
const RESULT_BUDGET_BYTES = 200_000
const RESULT_PREVIEW_BYTES = 64_000
const instructions = `Mako browser control uses one host-owned Chrome connection across tasks. Start with mako_browser_status, connect the chosen browser if needed, then open a tab or inspect tabs and select an exact ID. Keep the returned {browser,tab,generation,lease} handle. Every later operation uses that handle; there is no implicit active tab. Switching providers in the same Mako task retains host bindings; rediscover handles if script state is gone. Page bindings enable focus emulation so hidden tabs receive real input without activating the physical tab; release disables it. Explicit CDP can change that emulation when testing focus-dependent behavior.

Use observe for accessible UI and fresh element refs; use screenshot for visual content and coordinate grounding. Cross-check UI changes after actions. A new observation invalidates earlier refs, and navigation invalidates them too. Never guess refs, tab IDs or coordinates. A target-closed or stale-target error requires explicit rediscovery, never choosing the first available tab. A cancelled/timed-out action may have completed; observe before deciding what to do next. The host refuses further mutations on an uncertain binding until it is observed. click, hover, scroll, type and press send real input events; type reports the field it wrote into, and press covers keys that insertText cannot send (Enter, Tab, arrows, shortcuts).

For flexible workflows use mako_browser_exec with asynchronous JavaScript. browser.<action>({arguments}) has the same arguments as the matching MCP tool, excluding action. Await every call. state is a persistent object local to this MCP client. console.log emits text; emitImage(await browser.screenshot({target: state.tab})) emits a real image. Example: state.tab = await browser.open({browser:'chrome',url:'http://127.0.0.1:5173'}); console.log(await browser.observe({target:state.tab})); emitImage(await browser.screenshot({target:state.tab}));

Scripts run in a terminable local worker with a 60-second limit. They are trusted local JavaScript, not an OS sandbox. Return small results. Worker state resets after timeout/error; host tab bindings and the shared connection remain. Use mako_browser_help for protocol command schemas. CDP enables advanced network inspection, page evaluation, input, emulation, JavaScript dialogs, frame inspection and download configuration without requiring another browser runtime. Use explicit target lifecycle tools instead of raw Target mutations. For request interception or dialogs, enable the relevant domain first, read events, and use cdp with concurrent:true to unblock the pending operation; otherwise calls on one target are serialized. A page dialog (alert, confirm, prompt) blocks the tab until the dialog tool answers it; set its auto policy when a page is expected to raise dialogs. wait covers selectors, text, URL changes and network idle; download, pdf, cookies, frames, history and selectOption cover the rest of a page's lifecycle without raw protocol calls.

The browser with ID "mako" is Mako itself: open creates a hidden window of Mako's own interface (1600×1000, larger than the screen if needed) that only this task sees, so you can inspect, screenshot and drive the desk without touching the window the user is working in. It hosts Mako's interface only and does not navigate to other sites; close the tab when finished. Prefer it over computer tools whenever the target is Mako.

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

/** Keep every tool result inside a context window; report what was cut. */
function boundedText(value: z.infer<typeof z.json>) {
  const text = JSON.stringify(value)
  const bytes = Buffer.byteLength(text)
  if (bytes <= RESULT_BUDGET_BYTES) return { text, structuredContent: value }
  const summary = {
    truncated: true,
    bytes,
    budget: RESULT_BUDGET_BYTES,
    preview: text.slice(0, RESULT_PREVIEW_BYTES),
    note: "The full result exceeded the tool budget. Return a smaller value: select the fields you need, slice arrays, or read the page in parts.",
  }
  return { text: JSON.stringify(summary), structuredContent: summary }
}

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
    { name: "mako-browser-use", version: "2.1.0" },
    { capabilities: { tools: {}, logging: {} }, instructions }
  )
  server.onclose = () => {
    void runtime.close()
  }
  server.setRequestHandler(ListToolsRequestSchema, () =>
    ListToolsResultSchema.parse({
      tools: [
        ...BrowserCommandSchema.options.map((schema) => {
          // Input mode keeps defaulted fields optional; output mode would
          // publish every default as required.
          const input = serializedInput.parse(
            z.toJSONSchema(schema, { io: "input" })
          )
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
              $defs: input.$defs,
            },
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint:
                !readOnly &&
                ![
                  "connect",
                  "open",
                  "select",
                  "release",
                  "hover",
                  "scroll",
                  "history",
                  "selectOption",
                ].includes(action),
              idempotentHint:
                readOnly || ["connect", "release", "hover"].includes(action),
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
          inputSchema: z.toJSONSchema(BROWSER_TOOL_INPUTS.exec, {
            io: "input",
          }),
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
          inputSchema: z.toJSONSchema(BROWSER_TOOL_INPUTS.help, {
            io: "input",
          }),
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
    let dispatched = false
    try {
      if (request.params.name === "mako_browser_exec") {
        const { source } = BROWSER_TOOL_INPUTS.exec.parse(
          request.params.arguments
        )
        dispatched = true
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
      const action = request.params.name.replace(/^mako_browser_/, "")
      const parsed = BrowserCommandSchema.safeParse({
        ...request.params.arguments,
        action,
      })
      if (!parsed.success)
        throw new BrowserFault({
          code: "invalid-request",
          message: `Invalid arguments for ${request.params.name}. ${z.prettifyError(parsed.error).replace(/\s+/g, " ").trim()} Nothing was dispatched; correct the arguments and call again.`,
          outcome: "not-dispatched",
        })
      const command = parsed.data
      const token = request.params._meta?.progressToken
      if (command.action === "connect" && token !== undefined)
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: 0,
            total: 1,
            message:
              "Connecting to the browser profile. Tasks share the connection and keep separate tabs.",
          },
        })
      dispatched = true
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
      const bounded = boundedText(value)
      return {
        content: [{ type: "text", text: bounded.text }],
        structuredContent: { value: bounded.structuredContent },
      }
    } catch (error) {
      const fault =
        error instanceof BrowserFault
          ? error.detail
          : {
              code: dispatched ? "protocol-error" : "invalid-request",
              message:
                error instanceof Error
                  ? error.message
                  : "Browser operation failed",
              outcome: dispatched ? "unknown" : "not-dispatched",
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
