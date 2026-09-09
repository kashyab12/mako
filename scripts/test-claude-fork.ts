import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readClaudeForkPoint } from "../electron/providers/claude/sdk-transcript.js"

const root = await mkdtemp(join(tmpdir(), "mako-claude-fork-"))
const sessionId = randomUUID()
const path = join(root, `${sessionId}.jsonl`)
const answer = randomUUID()
const carrier = randomUUID()
const output = randomUUID()
const entry = (
  uuid: string,
  parentUuid: string | null,
  type = "assistant"
) => ({
  type,
  uuid,
  parentUuid,
  sessionId,
  isSidechain: false,
})
const rows = [
  entry(answer, null),
  entry(carrier, answer, "user"),
  entry(output, carrier, "attachment"),
  { type: "last-prompt", sessionId, leafUuid: output },
]
const save = (values: unknown[], suffix = "") =>
  writeFile(
    path,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n${suffix}`
  )
try {
  await save(rows)
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  await save(rows.slice(0, -1))
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save([
    ...rows,
    { type: "custom-title", sessionId, customTitle: "Test" },
  ])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  await save([...rows, { ...entry(randomUUID(), carrier), isSidechain: true }])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  await save([...rows, entry(randomUUID(), answer)])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save(rows, '{"type":')
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save([
    ...rows,
    { ...entry(randomUUID(), output), message: "x".repeat(1024 * 1024) },
  ])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save([
    { type: "tool-output", text: "x".repeat(17 * 1024 * 1024) },
    ...rows,
  ])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  assert.equal(
    await readClaudeForkPoint(path, sessionId, randomUUID()),
    undefined
  )
  assert.equal(await readClaudeForkPoint(path, randomUUID(), answer), undefined)
  console.log(
    "PASS: Claude fork keeps tool carriers and output attachments, bounds native tails, and refuses torn or ambiguous chains"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
