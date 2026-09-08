import assert from "node:assert/strict"
import { mkdtemp, writeFile, appendFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexProvider } from "../dist/providers/codex.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
const home = await mkdtemp(join(tmpdir(), "mako-settings-native-"))
const line = (value) => JSON.stringify(value) + "\n"
async function peek(provider, path) {
  const file = await stat(path)
  return provider.peek({ path, bytes: file.size, mtimeMs: file.mtimeMs })
}
try {
  const codex = new CodexProvider(home)
  const path = join(home, "codex.jsonl")
  await writeFile(path, line({ type: "session_meta", payload: { id: "test", cwd: home } }) +
    line({ type: "turn_context", payload: { model: "old", effort: "low", service_tier: "default" } }) +
    line({ type: "event_msg", payload: { type: "user_message", message: "hello" } }))
  await appendFile(path, "\n".repeat(3 * 1024 * 1024))
  assert.deepEqual((await peek(codex, path)).settings, {}, "an old head cannot be presented as a current setting")
  await appendFile(path, line({ type: "turn_context", payload: { model: "new", effort: "high", service_tier: "fast" } }))
  assert.deepEqual((await peek(codex, path)).settings, { model: "new", options: { effort: "high", serviceTier: "priority" } })
  const claude = new ClaudeProvider(home)
  const claudePath = join(home, "claude.jsonl")
  await writeFile(claudePath, line({ type: "user", sessionId: "claude", message: { content: "hello" } }) +
    line({ type: "assistant", message: { model: "old" } }) +
    line({ type: "assistant", message: { model: "new" } }) +
    line({ type: "assistant", isSidechain: true, message: { model: "subagent" } }))
  assert.deepEqual((await peek(claude, claudePath)).settings, { model: "new" })
  console.log("Native settings: latest turn wins, subagents are excluded, stale heads stay unknown, and speed aliases normalize")
} finally { await rm(home, { recursive: true, force: true }) }
