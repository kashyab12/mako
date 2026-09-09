import assert from "node:assert/strict"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeProvider } from "../dist/index.js"

const home = await mkdtemp(join(tmpdir(), "mako-claude-title-"))
const line = (value) => `${JSON.stringify(value)}\n`
const user = (text, uuid) =>
  line({
    type: "user",
    uuid,
    sessionId: "session-1",
    cwd: home,
    timestamp: "2026-09-08T21:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  })

async function peek(name, content) {
  const path = join(home, name)
  await writeFile(path, content)
  const info = await stat(path)
  return new ClaudeProvider(home).peek({
    path,
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  })
}

// Claude Code writes its own title after the fact and rewrites it as the
// conversation moves on. The rail shows the latest one, not the first prompt.
const titled = await peek(
  "titled.jsonl",
  user("[CleanShot 2026-09-08.png] Dude, why is Devin failing?", "u1") +
    line({ type: "ai-title", aiTitle: "Devin ACP failure", sessionId: "session-1" }) +
    user("Also the provider list is slow", "u2") +
    line({
      type: "ai-title",
      aiTitle: "Mako provider loading and harness issues",
      sessionId: "session-1",
    }) +
    line({ type: "last-prompt", lastPrompt: "Also the provider list is slow", sessionId: "session-1" })
)
assert.equal(titled?.title, "Mako provider loading and harness issues")

// Older files carried a summary record instead.
const summarized = await peek(
  "summary.jsonl",
  user("first prompt", "u1") +
    line({ type: "summary", summary: "Summarized title", leafUuid: "u1" })
)
assert.equal(summarized?.title, "Summarized title")

// With no written title the first prompt still names the thread.
const prompted = await peek("prompted.jsonl", user("Only a prompt here", "u1"))
assert.equal(prompted?.title, "Only a prompt here")

// The written title survives the transcript translation untouched.
const thread = await new ClaudeProvider(home).read(join(home, "titled.jsonl"))
assert.ok(thread)
assert.equal(
  thread.entries.filter((entry) => entry.kind === "user").length,
  2,
  "title records are not transcript entries"
)
console.log("Claude titles: written titles win over prompts, latest wins, legacy summary honored")
