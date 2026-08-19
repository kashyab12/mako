import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connectDaemon, serveCatalog } from "../dist/daemon.js"

const root = await mkdtemp(join(tmpdir(), "mako-daemon-test-"))
const socketPath = join(root, "syncd.sock")
const thread = {
  ref: { harness: "codex", nativeId: "slow", path: "/slow" },
  entries: [{ kind: "user", text: "Still opens" }],
}
const catalog = {
  list: () => [],
  open: async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    return thread
  },
  follow: () => () => {},
  onEvent: () => () => {},
}

const server = await serveCatalog(catalog, socketPath)
const client = await connectDaemon(socketPath, 100)
assert.deepEqual(await client.open(thread.ref.path), thread)
client.close()
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
await rm(root, { recursive: true, force: true })

console.log("Daemon checks clean: long transcript reads use an operation-specific deadline.")
