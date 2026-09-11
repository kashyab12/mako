import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { createComputerToolsServer } from "../electron/computer-tools-main.js"
import { canonicalDriverPath } from "../electron/computer-paths.js"

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
  // The driver refuses an output path whose deepest existing ancestor is a
  // symbolic link (macOS `/tmp`), so the wrapper forwards the real ancestor.
  const real = join(fixtureRoot, "real")
  const link = join(fixtureRoot, "link")
  await mkdir(real)
  await symlink(real, link)
  const realRoot = await realpath(real)
  assert.equal(
    await canonicalDriverPath(join(link, "nested", "shot.png")),
    join(realRoot, "nested", "shot.png")
  )
  assert.equal(
    await canonicalDriverPath("captures/shot.png", link),
    join(realRoot, "captures", "shot.png")
  )
  assert.equal(
    await canonicalDriverPath("~/mako-missing-dir/shot.png"),
    join(await realpath(homedir()), "mako-missing-dir", "shot.png")
  )
  const server = createComputerToolsServer(
    {
      command: process.execPath,
      args: ["--input-type=module", "--eval", source],
    },
    "paths"
  )
  const client = new Client({ name: "computer-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(st)
    await client.connect(ct)
    const result = await client.callTool({
      name: "mako_computer_get_window_state",
      arguments: {
        pid: 42,
        screenshot_out_file: join(link, "nested", "shot.png"),
        files: [join(link, "upload.txt"), "~"],
      },
    })
    const echoed = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(result.content)
    assert.deepEqual(JSON.parse(echoed[1]?.text ?? "{}"), {
      pid: 42,
      screenshot_out_file: join(realRoot, "nested", "shot.png"),
      files: [join(realRoot, "upload.txt"), await realpath(homedir())],
      session: "mako-paths",
    })
  } finally {
    await client.close()
    await server.close()
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}
console.log(
  "Computer MCP: native schema and annotations preserved, caller cannot override task session, image blocks and coordinate metadata forwarded intact, symlinked output ancestors resolved"
)
