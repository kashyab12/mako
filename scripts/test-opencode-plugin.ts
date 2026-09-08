import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { syncBuiltinESMExports } from "node:module"
import MakoActivityPlugin from "../electron/providers/opencode/activity-plugin.js"
import { openCodeRegistryActivity } from "../electron/providers/opencode/activity-registry.js"

const root = await mkdtemp(join(os.tmpdir(), "mako-opencode-plugin-"))
mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
const observer = await MakoActivityPlugin()
const directory = join(root, ".mako", "activity", "opencode")
async function until(status: "active" | "needs-input" | null) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const sessions = await openCodeRegistryActivity(
      directory,
      AbortSignal.timeout(1500)
    )
    if (
      status === null ? sessions.length === 0 : sessions[0]?.status === status
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${status} activity`)
}
try {
  await observer.event({
    event: {
      type: "session.status",
      properties: {
        sessionID: "ses_fixture",
        status: { type: "busy" },
        privateText: "do-not-retain",
      },
    },
  })
  await until("active")
  const filename = (await readdir(directory)).find((name) =>
    name.endsWith(".json")
  )
  assert.ok(filename)
  const raw = await readFile(join(directory, filename), "utf8")
  assert.equal(raw.includes("do-not-retain"), false)
  await observer.event({
    event: {
      type: "permission.asked",
      properties: { sessionID: "ses_fixture" },
    },
  })
  await until("needs-input")
  await observer.event({
    event: {
      type: "session.status",
      properties: { sessionID: "ses_fixture", status: { type: "idle" } },
    },
  })
  await until(null)
  await writeFile(
    join(directory, filename),
    raw.replace(/"updatedAt":\d+/, '"updatedAt":1')
  )
  await assert.rejects(
    openCodeRegistryActivity(directory, AbortSignal.timeout(1000)),
    /heartbeat is stale/
  )
  await observer.dispose()
  assert.deepEqual(await readdir(directory), [])
  console.log(
    "OpenCode v1 plugin: lifecycle, permission, idle, no transcript retention, heartbeat expiry and disposal passed"
  )
} finally {
  await observer.dispose()
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
