import { Appshots } from "../dist-electron/appshots.js"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
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

const runCommand = promisify(execFile)
async function frontmostPid() {
  const { stdout } = await runCommand("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier'], { timeout: 3000 })
  const pid = Number(stdout.trim())
  assert.ok(Number.isInteger(pid) && pid > 0)
  return pid
}
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
 app.setActivationPolicy("prohibited");
 const window = new BrowserWindow({show:false,width:650,height:420,title:'Mako control fixture',webPreferences:{contextIsolation:true}});
 await window.loadFile(${JSON.stringify(join(root, "fixture.html"))});
 window.showInactive();
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
let appshots
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
  await call("list_apps", {})
  const frontmostBefore = await frontmostPid()
  appshots = new Appshots(async () => ({ command: resolveExecutable("cua-driver"), args: ["mcp", "--embedded", "--socket", socket] }))
  const shot = await appshots.capture({ pid: target.pid, windowId: target.window_id })
  assert.ok(shot.image.data.length > 1000)
  assert.ok(shot.text.includes("Proof"), "Appshot includes text from the selected window")
  const first = await call("get_window_state", target)
  const image = first.content.find((block) => block.type === "image")
  assert.ok(image, "Actual screenshot must be returned through MCP")
  await writeFile(join(root, "fixture.png"), Buffer.from(image.data, "base64"))
  const field = first.structuredContent?.elements?.find(
    (element) => element.role === "AXTextField" && element.label === "Proof"
  )
  assert.ok(field, "Proof field must be found from live accessibility state")
  assert.ok(field.element_token)
  if (!process.argv.includes("--keys")) {
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
      assert.equal(observed.input, proof, "Background typing did not reach the exact target. Do not fall back to global input.")
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
  await call("list_apps", {})
  const frontmostAfter = await frontmostPid()
  assert.ok(frontmostBefore, "Native app discovery identifies the frontmost application")
  assert.equal(frontmostAfter, frontmostBefore, "Background actions must not change the user's frontmost application")
  assert.notEqual(frontmostAfter, target.pid, "Fixture stays in the background")
  outcome = { status: "passed", frontmostPreserved: true, appshot: { textCharacters: shot.text.length, imageBytes: Math.floor(shot.image.data.length * 3 / 4) } }
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
  await appshots?.close()
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
