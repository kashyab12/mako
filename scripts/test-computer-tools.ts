import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createComputerToolsServer } from "../electron/computer-tools-main.js"

const source = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'get_window_state',description:'Native capture',inputSchema:{type:'object',properties:{session:{type:'string'},pid:{type:'integer'}},required:['session','pid']},annotations:{readOnlyHint:true}}]}));
server.setRequestHandler(CallToolRequestSchema,request=>({content:[{type:'image',mimeType:'image/png',data:'aW1hZ2U='},{type:'text',text:JSON.stringify(request.params.arguments)}],structuredContent:{session:request.params.arguments.session,pid:request.params.arguments.pid,screenshot_scale:2}}));
await server.connect(new StdioServerTransport());
`
const fixtureRoot = await mkdtemp(join(tmpdir(), "mako-computer-reconnect-"))
try {
  for (const task of ["first", "second"]) {
    const marker = join(fixtureRoot, task)
    const failOnce = `import { existsSync, writeFileSync } from "node:fs"; const marker = ${JSON.stringify(marker)}; if (!existsSync(marker)) { writeFileSync(marker, "failed initialization"); process.exit(1); }\n`
    const server = createComputerToolsServer(
      {
        command: process.execPath,
        args: ["--input-type=module", "--eval", failOnce + source],
      },
      task
    )
    const client = new Client({ name: "computer-test", version: "1" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(st)
      await client.connect(ct)
      assert.match(client.getInstructions() ?? "", /independently inspect/i)
      await assert.rejects(client.listTools(), /closed/i)
      const tools = await client.listTools()
      const capture = tools.tools.find(
        (tool) => tool.name === "mako_computer_get_window_state"
      )
      assert.ok(capture)
      assert.equal(capture.inputSchema.properties?.session, undefined)
      assert.deepEqual(capture.inputSchema.required, ["pid"])
      assert.equal(capture.annotations?.readOnlyHint, true)
      const result = await client.callTool({
        name: capture.name,
        arguments: { pid: 42, session: "other-task" },
      })
      assert.equal(result.structuredContent?.session, `mako-${task}`)
      assert.equal(result.structuredContent?.screenshot_scale, 2)
      assert.deepEqual(result.content, [
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        {
          type: "text",
          text: JSON.stringify({ pid: 42, session: `mako-${task}` }),
        },
      ])
    } finally {
      await client.close()
      await server.close()
    }
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}
console.log(
  "Computer MCP: native schema and annotations preserved, caller cannot override task session, image blocks and coordinate metadata forwarded intact"
)
