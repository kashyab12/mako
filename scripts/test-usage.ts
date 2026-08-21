import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { usageSummary } from "../electron/usage.js"

const root = await mkdtemp(join(tmpdir(), "mako-usage-"))
const sessionsRoot = join(root, "built-in")
const homeRoot = join(root, "home")

try {
  const builtInRows = [
    JSON.stringify({
      type: "session",
      id: "built-1",
      cwd: "/work/reported",
    }),
    JSON.stringify({
      type: "message",
      id: "built-turn-1",
      timestamp: "2026-08-20T10:00:00.000Z",
      message: {
        model: "private-model",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 30,
          cacheWrite: 10,
          cost: { total: 0.123 },
        },
      },
    }),
  ]
  await putJsonl(join(sessionsRoot, "project-a", "original.jsonl"), builtInRows)
  await putJsonl(join(sessionsRoot, "project-a", "copy.jsonl"), builtInRows)

  const streamedClaudeTurn = claudeTurn(
    "claude-1",
    "msg-1",
    "req-1",
    "row-2",
    "claude-sonnet-4-6",
    2,
    15,
    100,
    20
  )
  await putJsonl(join(homeRoot, ".claude", "projects", "repo", "original.jsonl"), [
    claudeTurn(
      "claude-1",
      "msg-1",
      "req-1",
      "row-1",
      "claude-sonnet-4-6",
      2,
      10,
      100,
      20
    ),
    streamedClaudeTurn,
  ])
  await putJsonl(join(homeRoot, ".claude", "projects", "repo", "fork.jsonl"), [
    streamedClaudeTurn.replace('"claude-1"', '"claude-fork"'),
    claudeTurn(
      "claude-fork",
      "msg-2",
      "req-2",
      "row-3",
      "unpriced-model",
      7,
      3,
      0,
      0
    ),
  ])

  const firstCodex = codexUsage(
    "2026-08-20T12:00:01.000Z",
    rawCodex(100, 40, 10, 20),
    rawCodex(100, 40, 10, 20)
  )
  const secondCodex = codexUsage(
    "2026-08-20T12:00:02.000Z",
    rawCodex(160, 60, 15, 30),
    rawCodex(60, 20, 5, 10)
  )
  const repeatedSnapshot = codexUsage(
    "2026-08-20T12:00:03.000Z",
    rawCodex(160, 60, 15, 30),
    rawCodex(60, 20, 5, 10)
  )
  const codexPrefix = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-1", cwd: "/work/codex" },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { cwd: "/work/codex", model: "gpt-5" },
    }),
    firstCodex,
    secondCodex,
    repeatedSnapshot,
  ]
  await putJsonl(
    join(homeRoot, ".codex", "sessions", "2026", "08", "20", "original.jsonl"),
    codexPrefix
  )
  await putJsonl(
    join(homeRoot, ".codex", "sessions", "2026", "08", "20", "fork.jsonl"),
    [
      codexPrefix[0].replace('"codex-1"', '"codex-fork"'),
      ...codexPrefix.slice(1),
      codexUsage(
        "2026-08-20T12:00:04.000Z",
        rawCodex(190, 70, 15, 35),
        rawCodex(30, 10, 0, 5)
      ),
    ]
  )

  const summary = await usageSummary(sessionsRoot, homeRoot)

  assert.equal(summary.total.messages, 6)
  assert.equal(summary.sessions, 5)
  assert.equal(summary.total.input, 214)
  assert.equal(summary.total.output, 73)
  assert.equal(summary.total.cacheRead, 200)
  assert.equal(summary.total.cacheWrite, 45)
  assert.equal(summary.total.reportedCost, 0.123)
  assert.ok(Math.abs((summary.total.estimatedCost ?? 0) - 0.00084475) < 1e-12)
  assert.equal(summary.total.pricedTokens, 522)
  assert.equal(summary.total.unpricedTokens, 10)
  assert.deepEqual(
    summary.sources?.map((source) => source.source).sort(),
    ["Claude Code", "Codex", "Mako"]
  )

  const claude = summary.sources?.find((source) => source.source === "Claude Code")
  assert.equal(claude?.messages, 2)
  assert.equal(claude?.output, 18)
  const codex = summary.sources?.find((source) => source.source === "Codex")
  assert.equal(codex?.messages, 3)
  assert.equal(codex?.input, 105)
  assert.equal(codex?.cacheRead, 70)
  assert.equal(codex?.cacheWrite, 15)

  console.log("Local usage scanner fixtures passed")
} finally {
  await rm(root, { recursive: true, force: true })
}

async function putJsonl(path: string, rows: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${rows.join("\n")}\n`)
}

function claudeTurn(
  sessionId: string,
  messageId: string,
  requestId: string,
  uuid: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    requestId,
    uuid,
    timestamp: "2026-08-20T11:00:00.000Z",
    cwd: "/work/claude",
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  })
}

interface CodexTokens {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  total_tokens: number
}

function rawCodex(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number
): CodexTokens {
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: input + output,
  }
}

function codexUsage(
  timestamp: string,
  total: CodexTokens,
  last: CodexTokens
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
    },
  })
}
