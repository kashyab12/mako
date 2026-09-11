import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
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
server.setRequestHandler(CallToolRequestSchema,request=>({content:[{type:'image',mimeType:'image/png',data:'aW1hZ2U='},{type:'text',text:JSON.stringify(request.params.arguments)}],structuredContent:{session:request.params.arguments.session,pid:request.params.arguments.pid,max_elements:request.params.arguments.max_elements,screenshot_scale:2}}));
await server.connect(new StdioServerTransport());
`
// A driver-shaped fixture: numeric formats in its schemas, a window-state
// result that names its snapshot and writes the capture to disk, and an echo
// of every forwarded argument.
const driverSource = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'driver',version:'1'},{capabilities:{tools:{}}});
const target = {session:{type:'string'},pid:{type:'integer',format:'int32'},window_id:{type:'integer',format:'uint32'},element_token:{type:'string'},snapshot_id:{type:'string'},max_elements:{type:'integer',format:'uint32'},screenshot_out_file:{type:'string'}};
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:'get_window_state',description:'Capture',inputSchema:{type:'object',properties:target,required:['session','pid','window_id']},outputSchema:{type:'object',properties:{snapshot_id:{type:'string'},pid:{type:'integer',format:'int32'},window_id:{type:'integer',format:'uint32'},screenshot_scale:{type:'number',format:'double'}},required:['snapshot_id']}},
  {name:'click',description:'Click',inputSchema:{type:'object',properties:target,required:['session']}}
]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const args=request.params.arguments;
  if(request.params.name==='get_window_state'){
    const value={snapshot_id:'s0000000a',pid:args.pid,window_id:args.window_id,max_elements:args.max_elements,screenshot_scale:2,tree_markdown:'- [0] AXWindow',_note:'prefer elements',elements:[{element_token:'s0000000a:0'}],screenshot_file_path:args.screenshot_out_file,screenshot_mime_type:'image/png'};
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  }
  return {content:[{type:'text',text:JSON.stringify(args)}]};
});
await server.connect(new StdioServerTransport());
`
const fixtureRoot = await mkdtemp(join(tmpdir(), "mako-computer-reconnect-"))
const warnings: string[] = []
const originalWarn = console.warn
console.warn = (...values: unknown[]) => {
  warnings.push(values.map(String).join(" "))
}
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
      const session = z.string().parse(result.structuredContent?.session)
      assert.match(session, new RegExp(`^mako-${task}-[0-9a-f]{8}$`))
      assert.equal(result.structuredContent?.screenshot_scale, 2)
      const echoed = z
        .array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            data: z.string().optional(),
            mimeType: z.string().optional(),
          })
        )
        .parse(result.content)
      assert.deepEqual(echoed[0], {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
      })
      // The wrapper's compact text mirrors the structured result exactly.
      assert.deepEqual(JSON.parse(echoed[1]?.text ?? "{}"), {
        pid: 42,
        max_elements: 300,
        screenshot_scale: 2,
        session,
      })
      assert.equal(result.structuredContent?.max_elements, 300)
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

  // Previews are posted to the host's control endpoint; capture them here.
  const observations: Array<{
    operation: string
    status: string
    image?: { data: string; mimeType: string }
  }> = []
  const control = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8")
    })
    request.on("end", () => {
      observations.push(
        z
          .object({
            operation: z.string(),
            status: z.string(),
            image: z
              .object({ data: z.string(), mimeType: z.string() })
              .optional(),
          })
          .parse(JSON.parse(body))
      )
      response.writeHead(200).end("{}")
    })
  })
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve))
  const port = z.object({ port: z.number() }).parse(control.address()).port
  process.env.MAKO_CONTROL_URL = `http://127.0.0.1:${port}/browser`
  process.env.MAKO_CONTROL_TOKEN = "fixture-token"
  const server = createComputerToolsServer(
    {
      command: process.execPath,
      args: ["--input-type=module", "--eval", driverSource],
    },
    "paths"
  )
  const client = new Client({ name: "computer-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(st)
    await client.connect(ct)
    const listed = await client.listTools()
    const capture = listed.tools.find(
      (tool) => tool.name === "mako_computer_get_window_state"
    )
    assert.ok(capture?.inputSchema.properties?.include_markdown)
    assert.match(capture.description ?? "", /max_elements to 300/)
    const shot = join(link, "nested", "shot.png")
    await mkdir(join(realRoot, "nested"))
    const pixels = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=",
      "base64"
    )
    await writeFile(join(realRoot, "nested", "shot.png"), pixels)
    const result = await client.callTool({
      name: "mako_computer_get_window_state",
      arguments: { pid: 42, window_id: 7, screenshot_out_file: shot },
    })
    assert.ok(!result.isError, JSON.stringify(result))
    const structured = z
      .object({
        snapshot_id: z.string(),
        max_elements: z.number(),
        screenshot_file_path: z.string(),
        tree_markdown: z.string().optional(),
        _note: z.string().optional(),
      })
      .parse(result.structuredContent)
    assert.equal(structured.max_elements, 300)
    assert.equal(
      structured.screenshot_file_path,
      join(realRoot, "nested", "shot.png")
    )
    assert.equal(structured.tree_markdown, undefined)
    assert.equal(structured._note, undefined)
    const text = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(result.content)
    assert.ok(!text.some((block) => block.type === "image"))
    assert.ok(!(text[0]?.text ?? "").includes("tree_markdown"))
    const verbose = await client.callTool({
      name: "mako_computer_get_window_state",
      arguments: {
        pid: 42,
        window_id: 7,
        max_elements: 5,
        include_markdown: true,
      },
    })
    assert.equal(
      z
        .object({ tree_markdown: z.string(), max_elements: z.number() })
        .parse(verbose.structuredContent).max_elements,
      5
    )
    // A token names the snapshot; the pid and window that produced it follow.
    const click = await client.callTool({
      name: "mako_computer_click",
      arguments: { element_token: "s0000000a:3" },
    })
    const forwarded = z
      .object({ pid: z.number(), window_id: z.number(), session: z.string() })
      .parse(
        JSON.parse(
          z.array(z.object({ text: z.string() })).parse(click.content)[0].text
        )
      )
    assert.equal(forwarded.pid, 42)
    assert.equal(forwarded.window_id, 7)
    assert.match(forwarded.session, /^mako-paths-[0-9a-f]{8}$/)
    const explicit = await client.callTool({
      name: "mako_computer_click",
      arguments: { element_token: "s0000000a:3", pid: 99 },
    })
    assert.equal(
      z
        .object({ pid: z.number() })
        .parse(
          JSON.parse(
            z.array(z.object({ text: z.string() })).parse(explicit.content)[0]
              .text
          )
        ).pid,
      99
    )
    for (let attempt = 0; attempt < 100; attempt++) {
      if (observations.some((entry) => entry.image)) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const preview = observations.find(
      (entry) =>
        entry.operation === "get_window_state" && entry.status === "observed"
    )
    assert.ok(preview?.image, "the file capture reaches the preview")
    assert.equal(preview.image.mimeType, "image/png")
    assert.equal(preview.image.data, pixels.toString("base64"))
  } finally {
    await client.close()
    await server.close()
    control.close()
    delete process.env.MAKO_CONTROL_URL
    delete process.env.MAKO_CONTROL_TOKEN
  }
  assert.deepEqual(
    warnings.filter((line) => /unknown format/i.test(line)),
    [],
    "driver integer formats compile without validator warnings"
  )
} finally {
  console.warn = originalWarn
  await rm(fixtureRoot, { recursive: true, force: true })
}
console.log(
  "Computer MCP: native schema and annotations preserved, per-connection task session, symlinked output ancestors resolved, token-only actions carry their snapshot's pid and window, compact window state, file captures reach the preview, driver formats compile cleanly"
)
