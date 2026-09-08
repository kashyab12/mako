import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const directory = resolve("dist-electron")
if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-pip-e2e-"))
  const child = spawn(resolve("node_modules/.bin/electron"), [fileURLToPath(import.meta.url)], { stdio: "inherit", env: { ...process.env, MAKO_PIP_TEST_ROOT: root } })
  child.on("exit", (code) => { process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, ipcMain } = await import("electron")
  const { ControlPreviewWindow } = await import("../dist-electron/control-preview-window.js")
  const { ControlPreviews } = await import("../dist-electron/control-previews.js")
  const { BrowserService } = await import("../dist-electron/browser-service.js")
  const root = process.env.MAKO_PIP_TEST_ROOT
  assert.ok(root)
  app.setPath("userData", join(root, "data"))
  await app.whenReady()
  app.setActivationPolicy("prohibited")
  const execute = promisify(execFile)
  const frontmost = async () => Number((await execute("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier'])).stdout.trim())
  const before = await frontmost()
  const browser = new BrowserService()
  const previews = new ControlPreviews(browser, (image) => image, (activity) => pip.observe(activity))
  const pip = new ControlPreviewWindow(previews, directory, process.env.MAKO_TEST_ORIGIN ?? "http://127.0.0.1:5174/")
  ipcMain.handle("mako:control-preview", (_event, id, watching, watcher) => previews.read(id, watching, watcher))
  ipcMain.handle("mako:control-preview-hide", () => pip.hide())
  ipcMain.handle("mako:live-cancel", () => {})
  const fixture = new BrowserWindow({ show: false, width: 640, height: 360 })
  await fixture.loadURL("data:text/html,<body style='background:Canvas;color:CanvasText;font:24px system-ui'><h1>Live preview proof</h1><p id='step'>Step 1</p></body>")
  const activity = { conversationId: "pip-test", kind: "browser", operation: "navigate", target: "fixture", status: "running" }
  const publish = async () => {
    const shot = await fixture.webContents.capturePage()
    previews.observe(activity, { mimeType: "image/png", data: shot.toPNG().toString("base64") })
  }
  const wait = async (check) => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)) }
    throw new Error("Preview did not render")
  }
  try {
    await publish()
    const window = await wait(() => BrowserWindow.getAllWindows().find((entry) => entry !== fixture))
    await wait(() => window.webContents.executeJavaScript("Boolean(document.querySelector('img')?.naturalWidth)").catch(() => false))
    const first = await window.webContents.executeJavaScript("document.querySelector('img').src")
    assert.equal(window.isVisible(), true)
    assert.equal(window.isFocused(), false)
    await fixture.webContents.executeJavaScript("document.getElementById('step').textContent='Step 2'")
    await publish()
    await wait(async () => (await window.webContents.executeJavaScript("document.querySelector('img').src")) !== first)
    assert.equal(await frontmost(), before, "PiP must preserve the user's frontmost application")
    await writeFile(join(root, "preview.png"), (await window.webContents.capturePage()).toPNG())
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Hide preview\"]').click()")
    await wait(() => window.isDestroyed())
    await publish()
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(BrowserWindow.getAllWindows().length, 1, "Dismissed task must not immediately reopen the overlay")
    console.log(`PASS: native floating preview rendered two frames, preserved focus, and stayed dismissed. Evidence: ${root}`)
  } finally {
    pip.close(); previews.close(); browser.close(); fixture.destroy(); app.quit()
  }
}
