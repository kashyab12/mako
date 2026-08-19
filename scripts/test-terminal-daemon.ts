import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { TerminalDaemonClient, terminalEndpoint } from "../electron/terminal-client.ts"
import type { TerminalEvent } from "../electron/shared.ts"

const root = await mkdtemp(join(tmpdir(), "mako-terminal-"))
const stateDir = join(root, "state")
const entry = resolve("dist-electron/terminal-daemon.js")
const endpoint = terminalEndpoint(stateDir)
const child = spawn(process.execPath, [entry, "--endpoint", endpoint, "--state-dir", stateDir], {
  stdio: "ignore",
})

async function waitForSocket(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Terminal daemon exited with ${child.exitCode}`)
    try {
      await access(endpoint)
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }
  throw new Error("Terminal daemon socket did not appear")
}

function outputContaining(events: TerminalEvent[], marker: string): Promise<void> {
  return new Promise((resolveOutput, rejectOutput) => {
    const interval = setInterval(() => {
      if (!events.some((event) => event.type === "output" && event.data.includes(marker))) return
      clearInterval(interval)
      clearTimeout(timer)
      resolveOutput()
    }, 10)
    const timer = setTimeout(() => {
      clearInterval(interval)
      rejectOutput(new Error(`Terminal output did not contain ${marker}`))
    }, 5_000)
  })
}

await waitForSocket()
const events: TerminalEvent[] = []
const first = new TerminalDaemonClient(entry, stateDir, (event) => events.push(event))
const session = await first.create({ cwd: root, cols: 80, rows: 24, title: "Test" })
await first.attach(session.id)
const marker = `mako-terminal-${Date.now()}`
const seen = outputContaining(events, marker)
await first.write(session.id, `printf '${marker}\\n'\n`)
await seen
const snapshot = await first.attach(session.id)
assert.match(snapshot.data, new RegExp(marker))
first.dispose()

const second = new TerminalDaemonClient(entry, stateDir, () => {})
const sessions = await second.list()
assert.equal(sessions.some((entrySession) => entrySession.id === session.id), true)
const reattached = await second.attach(session.id)
assert.match(reattached.data, new RegExp(marker))
await second.kill(session.id)
second.dispose()

child.kill("SIGTERM")
await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()))
await rm(root, { recursive: true, force: true })

console.log("terminal daemon integration passed")
