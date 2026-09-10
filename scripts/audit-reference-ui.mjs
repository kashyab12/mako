import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"

if (!process.versions.electron) {
  const checkout = resolve(process.argv[2] ?? "")
  assert.ok(checkout.includes("/mako-t3-comparison-"))
  const root = await mkdtemp(join(tmpdir(), "mako-reference-ui-"))
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-reference-audit",
      main: fileURLToPath(import.meta.url),
    })
  )
  const { default: electron } = await import("electron")
  const env = {
    ...process.env,
    MAKO_REFERENCE_CHECKOUT: checkout,
    MAKO_REFERENCE_ROOT: root,
    MAKO_NODE_EXECUTABLE: process.execPath,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [root], { env, stdio: "inherit" })
  process.exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1))
  )
  console.log(`Reference UI evidence: ${root}`)
} else {
  void auditReference().catch(async (error) => {
    console.error(String(error))
    const { app } = await import("electron")
    app.exit(1)
  })
}

async function auditReference() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_REFERENCE_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const page = window.webContents
  const errors = []
  page.on("console-message", ({ level, message }) => {
    if (level === "error") errors.push(message)
  })
  page.debugger.attach("1.3")
  const evaluate = (source) => page.executeJavaScript(source)
  const wait = async (predicate) => {
    const deadline = Date.now() + 45000
    while (!(await evaluate(predicate))) {
      assert.ok(
        Date.now() < deadline,
        `Reference UI condition timed out: ${predicate}`
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  const clickText = async (text) => {
    const point = await evaluate(
      `(() => {const node=[...document.querySelectorAll('[role=button],a,button,span')].find(node=>node.textContent.trim()===${JSON.stringify(text)}); if(!node)return null; const rect=node.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`
    )
    assert.ok(point, `Missing reference control: ${text}`)
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...point,
      })
  }
  try {
    const checkout = process.env.MAKO_REFERENCE_CHECKOUT
    const child = spawn(
      process.env.MAKO_NODE_EXECUTABLE,
      [
        "apps/server/src/bin.ts",
        "pair",
        "--base-dir",
        join(checkout, "comparison-state"),
      ],
      { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] }
    )
    console.log("Creating an isolated reference pairing")
    const pairing = await new Promise((resolve, reject) => {
      let output = ""
      const timeout = setTimeout(() => {
        child.kill("SIGTERM")
        reject(new Error("Reference pairing CLI exceeded its deadline"))
      }, 45000)
      const consume = (data) => {
        output = (output + data.toString()).slice(-65536)
        const url = stripVTControlCharacters(output).match(
          /https?:\/\/[^\s]+\/pair#token=[^\s]+/
        )?.[0]
        if (url) {
          clearTimeout(timeout)
          resolve(url)
          child.kill("SIGTERM")
        }
      }
      child.stdout.on("data", consume)
      child.stderr.on("data", consume)
      child.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once("exit", (code) => {
        clearTimeout(timeout)
        reject(
          new Error(
            `Reference pairing CLI exited ${code} without a pairing URL`
          )
        )
      })
    })
    console.log("Opening the isolated reference client")
    await window.loadURL(pairing)
    await wait(
      "!location.pathname.includes('pair') && document.body.innerText.includes('Performance comparison')"
    )
    const cases = []
    for (const count of [10, 1000, 5000]) {
      const title = `Performance ${count} turns`
      const before = performance.now()
      await clickText(title)
      await wait(`document.body.innerText.includes('Finding ${count - 1}')`)
      cases.push({
        turns: count,
        openMs: performance.now() - before,
        ...(await evaluate(
          "({domNodes:document.querySelectorAll('*').length,renderedTextChars:document.body.innerText.length})"
        )),
      })
      await writeFile(
        join(root, `thread-${count}.png`),
        (await page.capturePage()).toPNG()
      )
    }
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(
        {
          app: "T3 Code",
          mode: "real development UI, seeded projections; not matched production throughput",
          cases,
          errors,
        },
        null,
        2
      )
    )
    console.log(JSON.stringify(cases))
  } catch (error) {
    await writeFile(
      join(root, "failure.png"),
      (await page.capturePage()).toPNG()
    )
    await writeFile(
      join(root, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          errors,
          ui: await evaluate(
            "({text:document.body.innerText.slice(0,12000),links:[...document.querySelectorAll('a,button')].map(node=>({text:node.textContent.trim(),href:node.getAttribute('href')})).slice(0,80)})"
          ),
        },
        null,
        2
      )
    )
    console.error(String(error))
    process.exitCode = 1
  } finally {
    window.destroy()
    app.exit(process.exitCode ?? 0)
  }
}
