import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
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
  assert.ok(tools.some((tool) => tool.name === "mako_browser_cdp"))
  assert.ok(tools.some((tool) => tool.name === "mako_browser_upload"))
  const invalid = await client.callTool({
    name: "mako_browser_click",
    arguments: { target: { browser: "fixture", tab: "tab", generation: "generation", lease: "lease" }, at: '{"ref":"not-an-object"}' },
  })
  assert.equal(invalid.isError, true)
  assert.equal(invalid.structuredContent?.outcome, "not-dispatched")
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
    "Browser MCP: documented typed tools, persistent scripts, native images with identity, protocol help, and connection survival after MCP close"
  )
} finally {
  await client.close()
  await server.close()
  service.close()
  await fixture.close()
}
