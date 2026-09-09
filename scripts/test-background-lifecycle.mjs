import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-background-test-"))
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-background-test",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = { ...process.env, MAKO_LIFECYCLE_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], {
    stdio: "inherit",
    env,
  })
  const [code] = await once(child, "exit")
  process.exitCode = code ?? 1
} else {
  void checkBackground().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
}

async function checkBackground() {
  const { app, BrowserWindow } = await import("electron")
  const { handleQuit } =
    await import("../dist-electron/background-lifecycle.js")
  app.setPath("userData", join(process.env.MAKO_LIFECYCLE_ROOT, "profile"))
  await app.whenReady()
  const { stderrDetail } = await import("../dist-electron/acp.js")
  assert.equal(
    stderrDetail(
      "Model unavailable\n\u001b[2m2026-09-09T00:00:00Z\u001b[0m  INFO SessionEnd dispatched"
    ),
    "Model unavailable"
  )
  assert.equal(
    stderrDetail("  2026-09-09T00:00:00Z INFO SessionEnd dispatched"),
    ""
  )
  const window = new BrowserWindow({
    show: false,
    width: 420,
    height: 240,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  await window.loadURL("data:text/html,<p>Preserved renderer and draft</p>")
  const worker = spawn(
    process.execPath,
    ["-e", "setInterval(() => console.log('provider-alive'), 30)"],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }
  )
  const watchdog = setTimeout(() => {
    worker.kill()
    app.exit(1)
  }, 15_000)
  let active = true
  let cleaned = false
  const pid = worker.pid
  const rendererId = window.webContents.id
  app.on("activate", () => window.showInactive())
  app.on("before-quit", (event) =>
    handleQuit(event, {
      hasActiveWork: () => active,
      isRestarting: () => false,
      hide: () => window.hide(),
      cleanup: () => {
        cleaned = true
        worker.kill()
      },
    })
  )
  try {
    await once(worker.stdout, "data")
    app.quit()
    await once(worker.stdout, "data")
    assert.equal(cleaned, false)
    assert.equal(worker.pid, pid)
    assert.equal(worker.exitCode, null)
    assert.equal(window.isDestroyed(), false)
    assert.equal(window.isVisible(), false)
    app.emit("activate")
    assert.equal(window.isVisible(), true)
    assert.equal(window.webContents.id, rendererId)
    assert.equal(
      await window.webContents.executeJavaScript("document.body.textContent"),
      "Preserved renderer and draft"
    )
    console.log(
      "PASS: real Electron quit backgrounds active work, the provider process continues, and activation reuses the same renderer"
    )
    active = false
    clearTimeout(watchdog)
    app.quit()
    assert.equal(cleaned, true)
  } catch (error) {
    console.error(error)
    worker.kill()
    app.exit(1)
  }
}
