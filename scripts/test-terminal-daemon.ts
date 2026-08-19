import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { TerminalDaemonClient, terminalEndpoint } from "../electron/terminal-client.ts"
import {
  TERMINAL_FLOW_HIGH_BYTES,
  TERMINAL_OUTPUT_CHUNK_BYTES,
} from "../electron/terminal-protocol.ts"
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

events.length = 0
const flowMarker = `mako-flow-${Date.now()}`
const flowMarkerAt = Math.floor(flowMarker.length / 2)
await first.write(
  session.id,
  `node -e "process.stdout.write('x'.repeat(2000000)); console.log('${flowMarker.slice(0, flowMarkerAt)}'+'${flowMarker.slice(flowMarkerAt)}')"\n`
)
await new Promise((resolveWait) => setTimeout(resolveWait, 250))
const beforeAcknowledge = events
  .filter((event) => event.type === "output")
  .reduce((bytes, event) => bytes + Buffer.byteLength(event.data), 0)
assert.ok(
  beforeAcknowledge <= TERMINAL_FLOW_HIGH_BYTES + TERMINAL_OUTPUT_CHUNK_BYTES * 4,
  `flow control admitted ${beforeAcknowledge} bytes before acknowledgment`
)
assert.equal(
  events.some(
    (event) => event.type === "output" && event.data.includes(flowMarker)
  ),
  false
)
let flowSnapshotData = ""
for (let attempt = 0; attempt < 250; attempt += 1) {
  const latest = events.reduce(
    (sequence, event) =>
      event.type === "output" ? Math.max(sequence, event.sequence) : sequence,
    0
  )
  if (latest > 0) await first.acknowledge(session.id, latest)
  const current = await first.attach(session.id)
  flowSnapshotData = current.data
  await first.acknowledge(session.id, current.sequence)
  if (
    flowSnapshotData.includes(flowMarker) ||
    events.some(
      (event) => event.type === "output" && event.data.includes(flowMarker)
    )
  ) {
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
}
assert.equal(
  flowSnapshotData.includes(flowMarker) ||
    events.some(
      (event) => event.type === "output" && event.data.includes(flowMarker)
    ),
  true
)

await first.detach(session.id)
const detachedMarker = `mako-detached-${Date.now()}`
await first.write(session.id, `printf '${detachedMarker}\\n'\n`)
await new Promise((resolveWait) => setTimeout(resolveWait, 100))
const detachedSnapshot = await first.attach(session.id)
assert.match(detachedSnapshot.data, new RegExp(detachedMarker))
first.dispose()

const secondEvents: TerminalEvent[] = []
const second = new TerminalDaemonClient(entry, stateDir, (event) =>
  secondEvents.push(event)
)
const sessions = await second.list()
assert.equal(sessions.some((entrySession) => entrySession.id === session.id), true)
const reattached = await second.attach(session.id)
assert.match(reattached.data, new RegExp(marker))

const processSession = await second.create({
  cwd: root,
  cols: 80,
  rows: 24,
  title: "Process group",
})
await second.attach(processSession.id)
secondEvents.length = 0
await second.write(processSession.id, "sleep 30 & echo MAKO_CHILD:$!\n")
let childPid = 0
for (let attempt = 0; attempt < 250; attempt += 1) {
  const childOutput = secondEvents
    .filter((event) => event.type === "output")
    .map((event) => event.data)
    .join("")
  childPid = Number(/MAKO_CHILD:(\d+)/.exec(childOutput)?.[1])
  if (childPid > 1) break
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
}
assert.ok(childPid > 1)
await second.kill(processSession.id)
await new Promise((resolveWait) => setTimeout(resolveWait, 100))
assert.throws(() => process.kill(childPid, 0))

await second.kill(session.id)
second.dispose()

child.kill("SIGTERM")
await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()))
await rm(root, { recursive: true, force: true })

console.log("terminal daemon integration passed")
