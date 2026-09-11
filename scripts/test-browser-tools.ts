import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { createBrowserToolsServer } from "../electron/browser-tools-main.js"
import { BrowserService } from "../electron/browser-service.js"
import { browserFixture } from "./browser-control-fixture.js"

const fixture = await browserFixture()
const service = new BrowserService([fixture.definition])
const server = createBrowserToolsServer((command, signal) =>
  service.execute("mcp-fixture", command, signal)
)
const client = new Client({ name: "browser-regression", version: "2" })
try {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  assert.match(client.getInstructions() ?? "", /no implicit active tab/)
  const tools = (await client.listTools()).tools
  for (const name of ["cdp", "upload", "hover", "scroll", "press"])
    assert.ok(
      tools.some((tool) => tool.name === `mako_browser_${name}`),
      name
    )
  // Published schemas: defaults stay optional, every property is described,
  // and the one recursive schema keeps its definitions resolvable.
  const published = z.object({
    name: z.string(),
    inputSchema: z.object({
      properties: z.record(
        z.string(),
        z.object({ description: z.string().optional() }).loose()
      ),
      required: z.array(z.string()).optional(),
      $defs: z.record(z.string(), z.json()).optional(),
    }),
  })
  for (const tool of tools.filter(
    (tool) => !["mako_browser_exec", "mako_browser_help"].includes(tool.name)
  )) {
    const schema = published.parse(tool)
    for (const [property, definition] of Object.entries(
      schema.inputSchema.properties
    ))
      assert.ok(
        definition.description || property === "target",
        `${tool.name}.${property} has a description`
      )
  }
  const openTool = published.parse(
    tools.find((tool) => tool.name === "mako_browser_open")
  )
  assert.deepEqual(openTool.inputSchema.required, ["browser"])
  const screenshotTool = published.parse(
    tools.find((tool) => tool.name === "mako_browser_screenshot")
  )
  assert.deepEqual(screenshotTool.inputSchema.required, ["target"])
  const cdpTool = published.parse(
    tools.find((tool) => tool.name === "mako_browser_cdp")
  )
  assert.deepEqual(cdpTool.inputSchema.required, ["target", "method"])
  const cdpText = JSON.stringify(cdpTool.inputSchema)
  for (const reference of cdpText.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g))
    assert.ok(
      cdpTool.inputSchema.$defs?.[reference[1]],
      `cdp $ref ${reference[1]} resolves`
    )
  const invalid = await client.callTool({
    name: "mako_browser_click",
    arguments: {
      target: {
        browser: "fixture",
        tab: "tab",
        generation: "generation",
        lease: "lease",
      },
      at: '{"ref":"not-an-object"}',
    },
  })
  assert.equal(invalid.isError, true)
  assert.equal(invalid.structuredContent?.outcome, "not-dispatched")
  assert.match(String(invalid.structuredContent?.message), /mako_browser_click/)
  assert.match(String(invalid.structuredContent?.message), /at/)
  assert.match(
    String(invalid.structuredContent?.message),
    /Nothing was dispatched/
  )
  assert.equal(fixture.calls.length, 0)
  assert.equal(fixture.connections(), 0)
  await client.callTool({
    name: "mako_browser_connect",
    arguments: { browser: "fixture" },
  })
  const result = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "state.tab = await browser.open({browser:'fixture'}); console.log(await browser.observe({target:state.tab})); emitImage(await browser.screenshot({target:state.tab,format:'png'}));",
    },
  })
  assert.ok(!result.isError, JSON.stringify(result))
  assert.ok(result.content.some((block) => block.type === "image"))
  assert.ok(
    result.content.some(
      (block) => block.type === "text" && block.text.includes('"target"')
    )
  )
  const persisted = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "return await browser.evaluate({target:state.tab,expression:'document.title'})",
    },
  })
  assert.ok(!persisted.isError, JSON.stringify(persisted))
  const handle = JSON.parse(
    String(
      z.array(z.object({ text: z.string().optional() })).parse(
        (
          await client.callTool({
            name: "mako_browser_exec",
            arguments: { source: "return state.tab" },
          })
        ).content
      )[0].text
    )
  )
  const oversized = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "return await browser.evaluate({target:state.tab,expression:'big-result'})",
    },
  })
  assert.equal(
    oversized.isError,
    true,
    "script output over the limit is refused"
  )
  const direct = await client.callTool({
    name: "mako_browser_evaluate",
    arguments: { target: handle, expression: "big-result" },
  })
  assert.ok(!direct.isError, JSON.stringify(direct).slice(0, 300))
  const truncated = z
    .object({
      value: z.object({
        truncated: z.literal(true),
        bytes: z.number(),
        preview: z.string(),
      }),
    })
    .parse(direct.structuredContent)
  assert.ok(truncated.value.bytes > 200_000)
  assert.ok(Buffer.byteLength(JSON.stringify(direct.content)) < 100_000)
  const help = await client.callTool({
    name: "mako_browser_help",
    arguments: { domain: "Input", method: "insertText" },
  })
  assert.ok(!help.isError)
  assert.match(JSON.stringify(help), /insertText/)
  await client.close()
  await server.close()
  assert.equal(service.status()[0].connection.status, "connected")
  assert.equal(fixture.connections(), 1)
  console.log(
    "Browser MCP: documented typed tools with optional defaults and resolvable definitions, actionable validation faults, bounded results, persistent scripts, native images with identity, protocol help, and connection survival after MCP close"
  )
} finally {
  await client.close()
  await server.close()
  service.close()
  await fixture.close()
}
