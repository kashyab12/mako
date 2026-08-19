import assert from "node:assert/strict"
import { mkdtemp, mkdir, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexProvider } from "../dist/providers/codex.js"

const home = await mkdtemp(join(tmpdir(), "mako-codex-large-"))
const sessions = join(home, ".codex", "sessions")
const path = join(sessions, "rollout.jsonl")
await mkdir(sessions, { recursive: true })
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
await rm(home, { recursive: true, force: true })

console.log("Large Codex checks clean: gigabyte rollouts translate from a bounded recent window.")
