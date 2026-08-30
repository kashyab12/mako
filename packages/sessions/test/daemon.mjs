import assert from "node:assert/strict"
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  connectDaemon,
  daemonMemoryUnsafe,
  MAX_DAEMON_RSS,
  serveCatalog,
} from "../dist/daemon.js"

assert.equal(daemonMemoryUnsafe(MAX_DAEMON_RSS), false)
assert.equal(daemonMemoryUnsafe(MAX_DAEMON_RSS + 1), true)

const root = await mkdtemp(join(tmpdir(), "mako-daemon-test-"))
const socketPath = join(root, "syncd.sock")
const thread = {
  ref: {
    harness: "codex",
    nativeId: "slow",
    path: "/slow",
    cwd: "/project/packages/app",
    workspace: "/project",
  },
  entries: [{ kind: "user", text: "Still opens — café 中文 🦈" }],
}
const page = {
  ref: thread.ref,
  entries: thread.entries,
  start: 0,
  total: 1,
  hasEarlier: false,
}
let deliverEntries
const catalog = {
  list: () => [],
  open: async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    return thread
  },
  page: async () => page,
  follow: (_path, _fromByte, listener) => {
    deliverEntries = listener
    return () => {
      deliverEntries = undefined
    }
  },
  onEvent: () => () => {},
  stop: () => {},
}

await writeFile(`${socketPath}.lock`, "99999999")
const server = await serveCatalog(catalog, socketPath)
assert.equal((await stat(socketPath)).mode & 0o777, 0o600)
await assert.rejects(
  serveCatalog(catalog, socketPath),
  /already (?:running|starting)/
)
const client = await connectDaemon(socketPath, 100)
const refreshed = await client.refresh()
assert.equal(refreshed.pid, process.pid)
assert.ok((refreshed.rss ?? 0) > 0)
assert.deepEqual(await client.open(thread.ref.path), thread)
assert.deepEqual(await client.page(thread.ref.path), page)
const streamed = new Promise((resolve) => {
  client.onEvent((event) => {
    if (event.event === "entries") resolve(event)
  })
})
await client.follow(thread.ref.path, 0)
deliverEntries?.([{ kind: "assistant", blocks: [{ type: "text", text: "Live" }] }], false)
assert.deepEqual(await streamed, {
  event: "entries",
  path: thread.ref.path,
  entries: [
    { kind: "assistant", blocks: [{ type: "text", text: "Live" }] },
  ],
  replace: false,
})
const oversized = createConnection(socketPath)
await new Promise((resolve, reject) => {
  oversized.once("connect", resolve)
  oversized.once("error", reject)
})
const rejected = new Promise((resolve) => oversized.once("close", resolve))
oversized.write("x".repeat(1024 * 1024 + 1))
await rejected
client.close()
await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve()))
)
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (!(await access(`${socketPath}.lock`).then(() => true, () => false))) break
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await assert.rejects(access(`${socketPath}.lock`))
const restarted = await serveCatalog(catalog, socketPath)
await new Promise((resolve, reject) =>
  restarted.close((error) => (error ? reject(error) : resolve()))
)
const racePath = join(root, "race.sock")
const raced = await Promise.allSettled([
  serveCatalog(catalog, racePath),
  serveCatalog(catalog, racePath),
])
const winner = raced.find((result) => result.status === "fulfilled")
assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1)
assert.ok(winner)
const retiring = await connectDaemon(racePath)
const retired = new Promise((resolve) => winner.value.once("close", resolve))
await retiring.retire()
await assert.rejects(connectDaemon(racePath, 200))
await retired
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (!(await access(`${racePath}.lock`).then(() => true, () => false))) break
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await assert.rejects(access(`${racePath}.lock`))
await rm(root, { recursive: true, force: true })

console.log("Daemon checks clean: locking, frame bounds, restart, long reads, and live broadcasts verified.")
