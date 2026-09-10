import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { auditSnapshot } from "./performance-audit-fixtures"

const checkout = resolve(process.argv[2] ?? "")
assert.ok(
  checkout.startsWith("/tmp/mako-t3-comparison-") ||
    checkout.startsWith("/private/tmp/mako-t3-comparison-")
)
const base = join(checkout, "comparison-state")
const quote = (value: string | number | null) =>
  value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`
const timestamp = "2026-09-09T10:00:00.000Z"
const projects: (string | number | null)[][] = [
  [
    "mako-perf-project",
    "Performance comparison",
    checkout,
    "[]",
    timestamp,
    timestamp,
  ],
]
const threads: (string | number | null)[][] = []
const turns: (string | number | null)[][] = []
const messages: (string | number | null)[][] = []
for (const count of [10, 1000, 5000]) {
  const id = `mako-perf-${count}`
  threads.push([
    id,
    "mako-perf-project",
    `Performance ${count} turns`,
    JSON.stringify({ instanceId: "codex", model: "gpt-5.4" }),
    `${id}-turn-${count - 1}`,
    timestamp,
    timestamp,
  ])
  const snapshot = auditSnapshot(count)
  for (let index = 0; index < count; index++) {
    const turn = `${id}-turn-${index}`
    const user = snapshot.blocks[index * 3]
    const answer = snapshot.blocks[index * 3 + 2]
    assert.ok(user?.type === "user" && answer?.type === "text")
    const at = new Date(Date.parse(timestamp) + index * 1000).toISOString()
    messages.push([`${turn}-user`, id, turn, "user", user.text, 0, at, at])
    messages.push([
      `${turn}-answer`,
      id,
      turn,
      "assistant",
      answer.text,
      0,
      at,
      at,
    ])
    turns.push([
      id,
      turn,
      `${turn}-user`,
      `${turn}-answer`,
      "completed",
      at,
      at,
      at,
      "[]",
    ])
  }
}
for (const [table, columns, values] of [
  [
    "projection_projects",
    "project_id,title,workspace_root,scripts_json,created_at,updated_at",
    projects,
  ],
  [
    "projection_threads",
    "thread_id,project_id,title,model_selection_json,latest_turn_id,created_at,updated_at",
    threads,
  ],
  [
    "projection_thread_messages",
    "message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at",
    messages,
  ],
  [
    "projection_turns",
    "thread_id,turn_id,pending_message_id,assistant_message_id,state,requested_at,started_at,completed_at,checkpoint_files_json",
    turns,
  ],
] as const) {
  const file = join(base, `${table}-fixture.sql`)
  await writeFile(
    file,
    `INSERT INTO ${table} (${columns}) VALUES ${values.map((row) => `(${row.map(quote).join(",")})`).join(",\n")} ON CONFLICT DO NOTHING;`
  )
  const result = spawnSync(
    process.execPath,
    [
      "apps/server/scripts/t3-sqlite-state.ts",
      "exec",
      "--base-dir",
      base,
      "--file",
      file,
    ],
    { cwd: checkout, encoding: "utf8", timeout: 60_000 }
  )
  assert.equal(result.status, 0, result.stderr)
  console.log(`Seeded ${table}: ${values.length} fixture rows`)
}
