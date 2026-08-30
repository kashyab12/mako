import assert from "node:assert/strict"
import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { readLines } from "../dist/jsonl.js"
import { CodexProvider } from "../dist/providers/codex.js"

const home = await mkdtemp(join(tmpdir(), "mako-codex-large-"))
const sessions = join(home, ".codex", "sessions")
const path = join(sessions, "rollout.jsonl")
await mkdir(sessions, { recursive: true })
const metadata = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
metadata.exec(`
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    name TEXT,
    title TEXT,
    first_user_message TEXT,
    cwd TEXT,
    updated_at_ms INTEGER,
    thread_source TEXT
  )
`)
metadata
  .prepare(
    "INSERT INTO threads (id, title, first_user_message, cwd, updated_at_ms, thread_source) VALUES (?, ?, ?, ?, ?, 'user')"
  )
  .run(
    "wrapped",
    "Update sequence links",
    "Investigate duplicate email synchronization carefully.",
    home,
    Date.parse("2026-08-20T00:00:00.000Z")
  )
metadata.close()
const handle = await open(path, "w")
const line = (type, payload) => JSON.stringify({ timestamp: "2026-08-19T00:00:00Z", type, payload }) + "\n"
await handle.write(line("session_meta", { id: "large", cwd: home }))
await handle.write(line("turn_context", { model: "gpt-5.6-sol" }))
await handle.write(line("response_item", { type: "message", role: "user", content: [{ text: "First prompt" }] }))
const tail =
  "\n" +
  line("response_item", { type: "message", role: "user", content: [{ text: "Recent prompt" }] }) +
  line("response_item", { type: "message", role: "assistant", content: [{ text: "Recent answer" }] })
await handle.write(tail, 65 * 1024 * 1024)
await handle.close()

const thread = await new CodexProvider(home).read(path)
assert.ok(thread)
assert.equal(thread.entries[0]?.kind, "event")
assert.match(thread.entries[0]?.detail ?? "", /most recent 64 MB/)
assert.ok(thread.entries.some((entry) => entry.kind === "user" && entry.text === "Recent prompt"))
assert.ok(!thread.entries.some((entry) => entry.kind === "user" && entry.text === "First prompt"))
const beforeFollow = await stat(path)
const follower = new CodexProvider(home).createFollower(path, beforeFollow.size)
await follower.next()
await appendFile(
  path,
  line("response_item", {
    type: "function_call_output",
    call_id: "missing-before-tail",
    output: "bounded recovery",
  })
)
const recovered = await follower.next()
assert.equal(recovered.reset, true)
assert.ok(
  !recovered.entries.some(
    (entry) => entry.kind === "user" && entry.text === "First prompt"
  )
)

const wrappedPath = join(sessions, "rollout-wrapped.jsonl")
await writeFile(
  wrappedPath,
  line("session_meta", { id: "wrapped", cwd: home }) +
    line("response_item", {
      type: "message",
      role: "user",
      content: [{ text: "<recommended_plugins>\ninternal" }],
    }) +
    line("response_item", {
      type: "message",
      role: "user",
      content: [
        {
          text: "# Files mentioned by the user:\n\n## report.csv: /tmp/report.csv\n\n## My request:\nInvestigate duplicate email synchronization carefully.",
        },
      ],
    }) +
    line("turn_context", { model: "gpt-5.6-sol" })
)
const wrappedInfo = await stat(wrappedPath)
const wrapped = await new CodexProvider(home).peek({
  path: wrappedPath,
  bytes: wrappedInfo.size,
  mtimeMs: wrappedInfo.mtimeMs,
})
assert.equal(wrapped?.title, "Update sequence links")
assert.equal(wrapped?.updatedAt, new Date(wrappedInfo.mtimeMs).toISOString())

const childPath = join(sessions, "rollout-subagent.jsonl")
await writeFile(
  childPath,
  line("session_meta", {
    id: "child-rollout",
    session_id: "parent-session",
    parent_thread_id: "parent-session",
    thread_source: "subagent",
    cwd: home,
  }) +
    line("session_meta", {
      id: "parent-session",
      session_id: "parent-session",
      thread_source: "user",
      cwd: home,
    })
)
const childInfo = await stat(childPath)
const child = await new CodexProvider(home).peek({
  path: childPath,
  bytes: childInfo.size,
  mtimeMs: childInfo.mtimeMs,
})
assert.equal(child, null)

const oversizedPath = join(sessions, "oversized-line.jsonl")
const oversized = await open(oversizedPath, "w")
await oversized.write(Buffer.from("{"), 0, 1, 0)
const afterOversized = line("session_meta", {
  id: "after-oversized",
  cwd: home,
})
await oversized.write(
  Buffer.from(`\n${afterOversized}`),
  0,
  Buffer.byteLength(`\n${afterOversized}`),
  20 * 1024 * 1024
)
await oversized.close()
const lines = []
await readLines(oversizedPath, 0, (raw) => lines.push(raw))
assert.equal(lines.length, 1)
assert.match(lines[0] ?? "", /after-oversized/)

await rm(home, { recursive: true, force: true })

console.log("Large Codex checks clean: gigabyte rollouts translate from a bounded recent window.")
