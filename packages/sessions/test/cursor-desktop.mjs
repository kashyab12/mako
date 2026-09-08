import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"
import { ThreadRefSchema } from "../dist/thread-schema.js"

const home = await mkdtemp(join(tmpdir(), "mako-cursor-desktop-"))
try {
  const root = join(home, process.platform === "darwin" ? "Library/Application Support/Cursor/User/globalStorage" : process.platform === "win32" ? "AppData/Roaming/Cursor/User/globalStorage" : ".config/Cursor/User/globalStorage")
  await mkdir(root, { recursive: true })
  const db = new DatabaseSync(join(root, "state.vscdb"))
  db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, lastUpdatedAt INTEGER, checkpointAt INTEGER, isSubagent INTEGER, value TEXT); CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)")
  const id = "12345678-1234-1234-1234-123456789abc"
  const header = {composerId: id, name: "Saved architecture review", createdAt: 1700000000000, lastUpdatedAt: 1700000001000, workspaceIdentifier: {uri: {fsPath: home}}}
  db.prepare("INSERT INTO composerHeaders VALUES (?,?,?,?,?)").run(id, header.lastUpdatedAt, 1, 0, JSON.stringify(header))
  const write = (key, value) => db.prepare("INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)").run(key, JSON.stringify(value))
  const bubbles = [
    {bubbleId: "user", type: 1, text: "Explain the architecture", images: [{filePath: join(home, "proof.png")}]},
    {bubbleId: "thinking", type: 2, thinking: {text: "**Inspecting** the modules"}},
    {bubbleId: "tool", type: 2, toolFormerData: {name: "read_file_v2", toolCallId: "call-1", params: '{"path":"app.ts"}', result: "", status: "completed"}},
    {bubbleId: "reply", type: 2, text: "The architecture has three layers."},
    {bubbleId: "oversized", type: 2, text: "x".repeat(2 * 1024 * 1024)},
  ]
  for (const bubble of bubbles) write(`bubbleId:${id}:${bubble.bubbleId}`, bubble)
  write(`composerData:${id}`, {fullConversationHeadersOnly: bubbles.map(({bubbleId}) => ({bubbleId})), modelConfig: {modelName: "provider-model"}, activeCanvas: {path: join(home, "architecture.canvas.tsx")}})
  db.close()
  const provider = new CursorProvider(home)
  const files = await provider.discover()
  assert.equal(files.length, 1)
  const ref = await provider.peek(files[0])
  assert.equal(ref.title, header.name)
  assert.equal(ref.cwd, home)
  assert.equal(ref.archived, undefined, "Desktop history remains eligible for archival")
  assert.ok(ref.resumeUnavailable, "Desktop IDs must never be sent to the CLI resume transport")
  assert.equal(ThreadRefSchema.parse(ref).resumeUnavailable, ref.resumeUnavailable)
  const thread = await provider.read(ref.path)
  assert.equal(thread.ref.model, "provider-model")
  assert.equal(thread.entries[0].attachments[0].source.path, join(home, "proof.png"))
  assert.equal(thread.entries[1].blocks[0].type, "thinking")
  assert.equal(thread.entries[2].blocks[0].output, "")
  assert.equal(thread.entries[3].blocks[0].text, bubbles[3].text)
  assert.equal(thread.entries[4].label, "Message unavailable", "Oversized native records produce an explicit marker")
  assert.equal(thread.entries.at(-1).blocks[0].mimeType, "text/x-cursor-canvas")
  assert.equal(thread.entries.at(-1).blocks[0].source.path, join(home, "architecture.canvas.tsx"))
  const follower = provider.createFollower(ref.path, 0)
  assert.deepEqual((await follower.next()).entries, [], "Opening an unchanged history is not streaming activity")
  const writer = new DatabaseSync(join(root, "state.vscdb"))
  writer.prepare("UPDATE composerHeaders SET checkpointAt = 2 WHERE composerId = ?").run(id)
  writer.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?").run(JSON.stringify({...bubbles[3], text: "Updated answer"}), `bubbleId:${id}:reply`)
  writer.close()
  const update = await follower.next()
  assert.equal(update.replace, true)
  assert.equal(update.entries[3].blocks[0].text, "Updated answer")
  assert.deepEqual((await follower.next()).entries, [], "A delivered revision is not replayed again")
  assert.equal(await provider.read(ref.path.replace(id, "../../foreign")), null)
  console.log("Cursor desktop discovery and bounded message reads preserve text, tools, media, Canvas, and continuation limits")
} finally {
  await rm(home, {recursive: true, force: true})
}
