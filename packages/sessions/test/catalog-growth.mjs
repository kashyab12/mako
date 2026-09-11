import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { ClaudeProvider } from "../dist/providers/claude.js"

const later = () => new Promise((resolve) => setTimeout(resolve, 20))
const home = await mkdtemp(join(tmpdir(), "mako-catalog-growth-"))
try {
  // A Codex rollout is one metadata line when first noticed. The prompt,
  // the model and Codex's own thread name all arrive after that.
  const sessions = join(home, ".codex", "sessions", "2026", "09", "11")
  await mkdir(sessions, { recursive: true })
  const parent = "01a08f72-7734-7cd1-829d-c10f7781531d"
  const child = "01a08f7f-c74a-7d70-839f-2cf4236d9c57"
  const rollout = join(sessions, `rollout-2026-09-11T00-50-38-${parent}.jsonl`)
  const resumed = join(sessions, `rollout-2026-09-11T01-05-11-${parent}_${child}.jsonl`)
  const line = (type, payload) => `${JSON.stringify({ timestamp: "2026-09-11T07:50:38Z", type, payload })}\n`
  const metadataPath = join(home, ".codex", "state_5.sqlite")
  const metadata = new DatabaseSync(metadataPath)
  metadata.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)"
  )
  metadata
    .prepare("INSERT INTO threads (id, name, title, cwd, updated_at_ms, thread_source, rollout_path) VALUES (?, NULL, ?, ?, ?, 'user', ?)")
    .run(parent, "Together AI reported this\n\n1. BCC", "/Users/kashyab/flage", Date.parse("2026-09-11T07:50:38Z"), rollout)
  metadata.close()
  await writeFile(rollout, line("session_meta", { id: parent, cwd: "/Users/kashyab/flage" }) + line("event_msg", { type: "task_started" }))

  const codex = new CodexProvider(home)
  const catalog = new SessionCatalog([codex], { cachePath: join(home, "cache.json") })
  const events = []
  catalog.onEvent((event) => events.push(event))
  const first = await catalog.scan()
  assert.equal(first.length, 1)
  assert.equal(first[0].title, undefined, "no prompt yet, so no title yet")

  await appendFile(
    rollout,
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\nnoise\n</recommended_plugins>" }] }) +
      line("turn_context", { model: "gpt-5.6-sol" }) +
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Together AI reported this\n\n1. BCC" }] })
  )
  const grown = await catalog.scan({ emitChanges: true })
  assert.equal(grown[0].title, "Together AI reported this", "growth re-reads a ref that had no title")
  assert.equal(grown[0].model, "gpt-5.6-sol")
  assert.equal(events.at(-1)?.type, "updated")

  // Codex names the thread in its database while the rollout keeps growing,
  // and a resumed thread continues in a `<id>_<suffix>` file that the
  // database names as current.
  const renamed = new DatabaseSync(metadataPath)
  renamed.prepare("UPDATE threads SET name = ?, updated_at_ms = ? WHERE id = ?")
    .run("Investigate email sequence behavior", Date.parse("2026-09-11T08:53:15Z"), parent)
  renamed.close()
  await later()
  await appendFile(rollout, line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] }))
  const named = await catalog.scan({ emitChanges: true })
  assert.deepEqual(named.map((ref) => ref.path), [rollout])
  assert.equal(named[0].title, "Investigate email sequence behavior", "the native name replaces the prompt title without rereading the rollout")
  assert.equal(named[0].cwd, "/Users/kashyab/flage")
  const resumedDb = new DatabaseSync(metadataPath)
  resumedDb.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(resumed, parent)
  resumedDb.close()
  await later()
  await writeFile(
    resumed,
    line("session_meta", { id: parent, cwd: "/Users/kashyab/flage", history_mode: "resume" }) +
      line("turn_context", { model: "gpt-5.6-sol" }) +
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Continue from here" }] })
  )
  const continued = await catalog.scan({ emitChanges: true })
  assert.deepEqual(continued.map((ref) => ref.path), [resumed], "the resumed file is the thread's one row")
  assert.equal(continued[0].title, "Investigate email sequence behavior")

  // A watcher that misses appends is caught by the active reconciliation:
  // the file grew, no event arrived, and the row still catches up.
  const before = events.length
  await appendFile(resumed, line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unreported append." }] }))
  await catalog.reconcileActive()
  assert.equal(events.length, before + 1, "reconciliation refreshed the grown file")
  assert.equal(events.at(-1)?.type, "updated")
  assert.equal(events.at(-1)?.ref.bytes, (await stat(resumed)).size)
  await catalog.reconcileActive()
  assert.equal(events.length, before + 1, "an unchanged active file is not refreshed again")
  await catalog.stop()

  // Claude writes its own title later in the same file.
  const projects = join(home, ".claude", "projects", "-Users-kashyab-flage")
  await mkdir(projects, { recursive: true })
  const session = join(projects, "62362b25-2460-43e5-9cff-390f9712d579.jsonl")
  const claudeLine = (value) => `${JSON.stringify(value)}\n`
  await writeFile(
    session,
    claudeLine({ type: "user", sessionId: "62362b25", cwd: "/Users/kashyab/flage", timestamp: "2026-09-11T07:00:00Z", message: { role: "user", content: "Fix the reply rate on the Together AI sequence" } }) +
      claudeLine({ type: "assistant", sessionId: "62362b25", timestamp: "2026-09-11T07:00:05Z", message: { role: "assistant", model: "claude-fable-5", content: [{ type: "text", text: "On it." }] } })
  )
  const claude = new ClaudeProvider(home)
  const claudeCatalog = new SessionCatalog([claude], { cachePath: join(home, "claude-cache.json") })
  const [prompted] = await claudeCatalog.scan()
  assert.equal(prompted.title, "Fix the reply rate on the Together AI sequence")
  await appendFile(session, claudeLine({ type: "ai-title", sessionId: "62362b25", aiTitle: "Together AI reply-rate fix" }))
  const [titled] = await claudeCatalog.scan({ emitChanges: true })
  assert.equal(titled.title, "Together AI reply-rate fix", "an appended ai-title reaches the row")
  await claudeCatalog.stop()
  console.log(
    "Catalog growth: untitled refs are re-read when their file grows, Codex names from the state database and Claude ai-title lines reach existing rows, a resumed Codex file stays one row, and active files missed by the watcher reconcile"
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
