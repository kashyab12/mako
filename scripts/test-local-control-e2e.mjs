import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { resolveExecutable } from "../dist-electron/executable.js"
import {
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"

const root = await mkdtemp(join(tmpdir(), "mako-control-e2e-"))
const proof = randomUUID()
const statusFile = join(root, "status.json")
const fixtureFile = join(root, "fixture.cjs")
await writeFile(
  join(root, "fixture.html"),
  `<title>Mako control fixture</title><h1>Mako control fixture</h1><label>Proof <input aria-label="Proof" id="proof"></label><button onclick="document.getElementById('result').textContent=document.getElementById('proof').value">Verify proof</button><output id="result"></output>`
)
await writeFile(
  fixtureFile,
  `
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(root, "user-data"))});
app.whenReady().then(async () => {
 app.setAccessibilitySupportEnabled(true);
 const window = new BrowserWindow({width:650,height:420,title:'Mako control fixture',webPreferences:{contextIsolation:true}});
 await window.loadFile(${JSON.stringify(join(root, "fixture.html"))});
 setInterval(async () => { if (!window.isDestroyed()) fs.writeFileSync(${JSON.stringify(statusFile + ".next")}, JSON.stringify({pid:process.pid, input:await window.webContents.executeJavaScript('document.getElementById("proof").value'), value:await window.webContents.executeJavaScript('document.getElementById("result").textContent')})); fs.renameSync(${JSON.stringify(statusFile + ".next")}, ${JSON.stringify(statusFile)}); }, 100);
});
app.on('window-all-closed', () => app.quit());
`
)
const fixture = spawn(resolve("node_modules/.bin/electron"), [fixtureFile], {
  stdio: ["ignore", "ignore", "pipe"],
})
fixture.stderr.on("data", (chunk) => process.stderr.write(chunk))
const client = new Client({ name: "mako-control-e2e", version: "1" })
let outcome = { status: "failed", error: "Test did not complete" }
const events = []
const session = `mako-fixture-${randomUUID()}`
async function call(name, args) {
  const start = performance.now()
  const { session: _session, ...input } = args
  const result = await client.callTool({
    name: `mako_computer_${name}`,
    arguments: input,
  })
  events.push({
    name,
    args,
    milliseconds: Math.round(performance.now() - start),
    result,
  })
  return result
}
async function until(check) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Fixture condition timed out")
}
try {
  const fixtureStatus = await until(async () => {
    try {
      return JSON.parse(await readFile(statusFile, "utf8"))
    } catch {
      return null
    }
  })
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.audit")
  assert.ok(socket)
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("dist-electron/computer-tools-main.js"),
        "--driver",
        resolveExecutable("cua-driver"),
        "--socket",
        socket,
      ],
      stderr: "pipe",
    })
  )
  const permissions = await call("check_permissions", { prompt: false })
  assert.equal(permissions.structuredContent?.accessibility, true)
  await call("start_session", { session, capture_scope: "window" })
  const windows = await call("list_windows", { pid: fixtureStatus.pid })
  const data = windows.structuredContent
  const window = data?.windows?.find(
    (entry) =>
      entry.pid === fixtureStatus.pid && entry.title === "Mako control fixture"
  )
  assert.ok(window, "Fixture window must be discovered by its actual pid")
  const target = {
    pid: fixtureStatus.pid,
    window_id: window.window_id,
    session,
  }
  const first = await call("get_window_state", target)
  const image = first.content.find((block) => block.type === "image")
  assert.ok(image, "Actual screenshot must be returned through MCP")
  await writeFile(join(root, "fixture.png"), Buffer.from(image.data, "base64"))
  const field = first.structuredContent?.elements?.find(
    (element) => element.role === "AXTextField" && element.label === "Proof"
  )
  assert.ok(field, "Proof field must be found from live accessibility state")
  assert.ok(field.element_token)
  if (process.argv.includes("--fill")) {
    const filled = await call("set_value", {
      ...target,
      element_token: field.element_token,
      value: proof,
    })
    assert.ok(!filled.isError, JSON.stringify(filled.structuredContent))
  } else {
    await call("click", { ...target, element_token: field.element_token })
    const typed = await call("type_text", {
      ...target,
      element_token: field.element_token,
      text: proof,
    })
    if (typed.isError) {
      assert.equal(
        typed.structuredContent?.delivered_chars,
        0,
        "Only a proven zero-delivery action may be retried in full"
      )
      const observed = JSON.parse(await readFile(statusFile, "utf8"))
      if (observed.input !== proof) {
        assert.equal(observed.input, "")
        const frame = first.structuredContent
        assert.equal(frame.screenshot_frame_valid, true)
        const x =
          (field.frame.x - frame.window_bounds.x + field.frame.w / 2) *
          frame.screenshot_scale
        const y =
          (field.frame.y - frame.window_bounds.y + field.frame.h / 2) *
          frame.screenshot_scale
        const retry = await call("type_text", {
          ...target,
          x,
          y,
          text: proof,
          delivery_mode: "foreground",
        })
        assert.ok(!retry.isError, JSON.stringify(retry.structuredContent))
      }
    }
  }
  await until(
    async () => JSON.parse(await readFile(statusFile, "utf8")).input === proof
  )
  const second = await call("get_window_state", {
    ...target,
    include_screenshot: false,
  })
  const button = second.structuredContent?.elements?.find(
    (element) =>
      /button/i.test(element.role) && element.label === "Verify proof"
  )
  assert.ok(button)
  await call("click", { ...target, element_token: button.element_token })
  await until(
    async () => JSON.parse(await readFile(statusFile, "utf8")).value === proof
  )
  const stale = await call("click", {
    ...target,
    element_token: field.element_token,
  })
  assert.equal(
    stale.isError,
    true,
    "Superseded accessibility references must be refused"
  )
  outcome = { status: "passed" }
  console.log(
    "PASS: native screenshot, observed field entry, button action, independent renderer readback, stale-reference refusal"
  )
} catch (error) {
  outcome = {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  }
  throw error
} finally {
  await call("end_session", { session }).catch(() => {})
  await client.close()
  stopCuaEmbedded()
  fixture.kill("SIGTERM")
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(
      {
        host: "Node launched by Codex; signed Mako release not certified",
        outcome,
        proof,
        events,
      },
      null,
      2
    )
  )
  console.log("Evidence:", root)
}
