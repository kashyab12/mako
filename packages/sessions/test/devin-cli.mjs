import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DevinCliProvider } from "../dist/providers/devin-cli.js"

const home = mkdtempSync(join(tmpdir(), "mako-devin-cli-"))
const dir = join(home, ".local", "share", "devin", "cli")
await mkdir(dir, { recursive: true })
const database = new DatabaseSync(join(dir, "sessions.db"))

database.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    hidden INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    working_directory TEXT NOT NULL,
    model TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_id INTEGER NOT NULL,
    chat_message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`)

database
  .prepare("INSERT INTO sessions VALUES (?, 0, ?, ?, ?, ?, ?)")
  .run("session-1", 2, "/work", "gpt-5-6-sol-high-priority", "Live session", 1)
const insert = database.prepare(
  "INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)"
)
insert.run(1, "session-1", 1, JSON.stringify({ role: "user", content: "hello" }), 1)
insert.run(
  2,
  "session-1",
  2,
  JSON.stringify({
    role: "assistant",
    thinking: { text: "checking" },
    content: "",
    tool_calls: [
      {
        id: "tool-1",
        function: { name: "shell", arguments: { command: "pwd" } },
      },
    ],
  }),
  2
)

database.close()

try {
  const provider = new DevinCliProvider(home)
  const [file] = await provider.discover()
  assert.ok(file)
  assert.equal(file.bytes, 2)

  const opened = await provider.read(file.path)
  assert.ok(opened)
  assert.equal(opened.ref.model, "gpt-5-6-sol-high-priority")
  assert.equal(opened.entries.length, 2)
  const firstTool = opened.entries
    .filter((entry) => entry.kind === "assistant")
    .flatMap((entry) => entry.blocks)
    .find((block) => block.type === "tool")
  assert.equal(firstTool?.name, "shell")
  assert.equal(firstTool?.output, undefined)

  const follower = provider.createFollower(file.path, file.bytes)
  const writable = new DatabaseSync(join(dir, "sessions.db"))
  writable
    .prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)")
    .run(
      3,
      "session-1",
      3,
      JSON.stringify({ role: "tool", tool_call_id: "tool-1", content: "/work" }),
      3
    )
  writable
    .prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
    .run(3, "session-1")
  writable.close()

  const completed = await follower.next()
  assert.equal(completed.replace, true)
  assert.equal(completed.replaceFrom, 0)
  const completedTool = completed.entries
    .filter((entry) => entry.kind === "assistant")
    .flatMap((entry) => entry.blocks)
    .find((block) => block.type === "tool")
  assert.equal(completedTool?.output, "/work")

  const continued = new DatabaseSync(join(dir, "sessions.db"))
  continued
    .prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)")
    .run(4, "session-1", 4, JSON.stringify({ role: "user", content: "continue" }), 4)
  continued
    .prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?)")
    .run(5, "session-1", 5, JSON.stringify({ role: "assistant", content: "done" }), 5)
  continued.close()

  const appended = await follower.next()
  assert.equal(appended.replace, false)
  assert.deepEqual(
    appended.entries.map((entry) => entry.kind),
    ["user", "assistant"]
  )
  assert.equal(appended.nextByte, 5)
  console.log("Devin CLI tests clean: streamed rows, tools, thinking, and incremental follow verified.")
} finally {
  rmSync(home, { recursive: true, force: true })
}
