import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { SessionArchive } from "../dist/archive.js"
import { SessionCatalog } from "../dist/catalog.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { emitCursorSession } from "../dist/emit.js"
import { userTextFrom } from "../dist/format.js"

const home = await mkdtemp(join(tmpdir(), "mako-integrity-"))
const line = value => JSON.stringify(value) + "\n"
const archive = new SessionArchive(join(home, "archive"))
let db
let catalog
try {
  const ref = { harness: "claude", nativeId: "test", path: join(home, "native"), bytes: 1 }
  const entries = [{ kind: "user", text: "run" }, { kind: "assistant", blocks: [{ type: "tool", name: "shell" }] }]
  archive.note(ref, async () => ({ ref, entries }))
  await archive.flush()
  entries[1].blocks[0].output = "complete"
  const next = { ...ref, bytes: 2 }
  archive.note(next, async () => ({ ref: next, entries }))
  await archive.flush()
  assert.equal((await archive.read(ref.path)).entries[1].blocks[0].output, "complete")
  assert.equal((await archive.read(ref.path)).ref.bytes, 2)
  archive.note({ ...next, bytes: 3 }, async () => ({ ref: next, entries }))
  await archive.forget(ref.path)
  await archive.flush()
  assert.equal(await archive.read(ref.path), null, "queued writes cannot resurrect forgotten history")

  const dir = join(home, ".claude", "projects", "p")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "session.jsonl")
  const first = line({ type: "user", sessionId: "s", cwd: home, message: { content: "first" } })
  const second = line({ type: "user", sessionId: "s", cwd: home, message: { content: "second" } })
  await writeFile(path, first + second.slice(0, 20))
  const provider = new ClaudeProvider(home)
  const opened = await provider.read(path)
  assert.equal(opened.checkpoint, Buffer.byteLength(first))
  const follower = provider.createFollower(path, opened.checkpoint)
  await appendFile(path, second.slice(20))
  assert.equal((await follower.next()).entries[0].text, "second")

  const captured = join(home, "startup-archive")
  catalog = new SessionCatalog([provider], { archivePath: captured })
  await catalog.scan()
  await new Promise(resolve => setTimeout(resolve, 3400))
  const startup = new SessionArchive(captured)
  assert.equal((await startup.read(path)).entries.length, 2, "initial discovery archives unchanged sessions")
  await startup.stop()
  await catalog.stop()

  const emitted = await emitCursorSession({ ref: { ...ref, harness: "cursor", title: "before", cwd: home }, entries: [{ kind: "user", text: "hello" }] }, { cwd: home, home })
  db = new DatabaseSync(emitted.path)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)")
  const cursor = new CursorProvider(home)
  catalog = new SessionCatalog([cursor])
  await catalog.scan()
  const before = await stat(emitted.path)
  const row = db.prepare("SELECT value FROM meta WHERE key='0'").get()
  const meta = JSON.parse(Buffer.from(String(row.value), "hex").toString())
  meta.name = "after"
  db.prepare("UPDATE meta SET value=? WHERE key='0'").run(Buffer.from(JSON.stringify(meta)).toString("hex"))
  assert.equal((await stat(emitted.path)).mtimeMs, before.mtimeMs)
  await catalog.scan()
  assert.equal(catalog.list()[0].title, "after", "WAL changes invalidate the catalog")
  assert.equal(userTextFrom("<recommended_plugins>list</recommended_plugins>\n\nKeep this request."), "Keep this request.")
  console.log("Storage integrity passed: atomic content updates, deletion ordering, startup capture, complete-record checkpoint, WAL revisions, envelope fidelity")
} finally {
  await archive.flush()
  await archive.stop()
  await catalog?.stop()
  db?.close()
  await new Promise(resolve => setTimeout(resolve, 20))
  await rm(home, { recursive: true, force: true })
}
