import assert from "node:assert/strict"
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { SessionCatalog } from "../dist/catalog.js"
import { EntrySink } from "../dist/format.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { DevinLocalProvider } from "../dist/providers/devin-local.js"
import { GrokProvider } from "../dist/providers/grok.js"
import { PiProvider } from "../dist/providers/pi.js"

const scratch = []
const temp = (name) => {
  const path = mkdtempSync(join(tmpdir(), `sessions-stream-${name}-`))
  scratch.push(path)
  return path
}
const line = (value) => `${JSON.stringify(value)}\n`
const refresh = (catalog, provider, path) => catalog.refresh(provider, path)
const apply = (entries, update) =>
  update.replace
    ? [...entries.slice(0, update.replaceFrom ?? 0), ...update.entries]
    : [...entries, ...update.entries]

function fileProvider(root, hooks = {}) {
  let peekCalls = 0
  const tailOffsets = []
  return {
    harness: "test",
    displayName: "Test",
    roots: () => [root],
    discover: async () => {
      const path = join(root, "session.jsonl")
      const info = await stat(path)
      return [{ path, bytes: info.size, mtimeMs: info.mtimeMs }]
    },
    peek: async (file) => {
      peekCalls += 1
      return {
        harness: "test",
        nativeId: "test-session",
        path: file.path,
        bytes: file.bytes,
        updatedAt: new Date(file.mtimeMs).toISOString(),
      }
    },
    read: async (path) => ({
      ref: { harness: "test", nativeId: "test-session", path },
      entries: (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((text) => ({ kind: "user", text })),
    }),
    tail: async (path, fromByte) => {
      tailOffsets.push(fromByte)
      if (hooks.tail) return hooks.tail(path, fromByte, tailOffsets.length)
      const raw = await readFile(path)
      const text = raw.subarray(fromByte).toString("utf8")
      return {
        entries: text
          .split("\n")
          .filter(Boolean)
          .map((value) => ({ kind: "user", text: value })),
        nextByte: raw.length,
      }
    },
    get peekCalls() {
      return peekCalls
    },
    tailOffsets,
  }
}

async function concurrentRefreshRace() {
  const root = temp("race")
  const path = join(root, "session.jsonl")
  await writeFile(path, "")
  let releaseFirst
  let firstStarted
  const released = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const started = new Promise((resolve) => {
    firstStarted = resolve
  })
  const provider = fileProvider(root, {
    tail: async (file, fromByte, call) => {
      const raw = await readFile(file)
      if (call === 1) {
        firstStarted()
        await released
      }
      const text = raw.subarray(fromByte).toString("utf8")
      return {
        entries: text
          .split("\n")
          .filter(Boolean)
          .map((value) => ({ kind: "user", text: value })),
        nextByte: raw.length,
      }
    },
  })
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  const received = []
  catalog.follow(path, 0, (entries, replaced) => {
    assert.equal(replaced, false)
    received.push(...entries.map((entry) => entry.text))
  })

  await appendFile(path, "A\n")
  const first = refresh(catalog, provider, path)
  await started
  await appendFile(path, "B\n")
  const second = refresh(catalog, provider, path)
  releaseFirst()
  await Promise.all([first, second])

  assert.deepEqual(received, ["A", "B"])
  assert.deepEqual(provider.tailOffsets, [0, 2])
  catalog.stop()
}

async function cursorNeverRegresses() {
  const root = temp("cursor")
  const path = join(root, "session.jsonl")
  await writeFile(path, "12345")
  const provider = fileProvider(root, {
    tail: async (_path, _fromByte) => ({ entries: [], nextByte: 1 }),
  })
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  catalog.follow(path, 5, () => {})

  await appendFile(path, "6")
  await refresh(catalog, provider, path)
  await appendFile(path, "7")
  await refresh(catalog, provider, path)

  assert.deepEqual(provider.tailOffsets, [5, 5])
  catalog.stop()
}

async function shrinkReplaces() {
  const home = temp("shrink")
  const dir = join(home, ".pi", "agent", "sessions", "project")
  const path = join(dir, "thread.jsonl")
  await mkdir(dir, { recursive: true })
  const initial =
    line({
      type: "session",
      id: "old-session",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/old",
    }) +
    line({
      type: "message",
      timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: "a much longer original prompt" },
    }) +
    line({
      type: "message",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "a much longer original response" }],
      },
    })
  await writeFile(path, initial)
  const provider = new PiProvider(home)
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  const updates = []
  catalog.follow(path, Buffer.byteLength(initial), (entries, replaced) =>
    updates.push({ entries, replaced })
  )

  const rewritten =
    line({ type: "session", id: "new-session", cwd: "/new" }) +
    line({ type: "message", message: { role: "user", content: "new" } })
  assert.ok(Buffer.byteLength(rewritten) < Buffer.byteLength(initial))
  await writeFile(path, rewritten)
  await refresh(catalog, provider, path)

  const full = await provider.read(path)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].replaced, true)
  assert.deepEqual(updates[0].entries, full.entries)
  assert.equal(catalog.list()[0].nativeId, "new-session")

  const replacementPath = `${path}.replacement`
  const replacement =
    line({ type: "session", id: "replacement-session", cwd: "/replacement" }) +
    line({
      type: "message",
      message: {
        role: "user",
        content: "replacement prompt that is larger than the compacted file",
      },
    }) +
    line({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "replacement response" }],
      },
    })
  await writeFile(replacementPath, replacement)
  await rename(replacementPath, path)
  await refresh(catalog, provider, path)

  const replacedFull = await provider.read(path)
  assert.equal(updates.length, 2)
  assert.equal(updates[1].replaced, true)
  assert.deepEqual(updates[1].entries, replacedFull.entries)
  assert.equal(catalog.list()[0].nativeId, "replacement-session")
  catalog.stop()
}

const CASES = [
  {
    name: "claude",
    setup: async () => {
      const home = temp("claude")
      const path = join(home, ".claude", "projects", "project", "session.jsonl")
      await mkdir(dirname(path), { recursive: true })
      return {
        provider: new ClaudeProvider(home),
        path,
        batches: [
          line({
            type: "user",
            sessionId: "claude-session",
            cwd: "/work",
            timestamp: "2026-01-01T00:00:00Z",
            message: { content: "hello" },
          }) +
            line({
              type: "assistant",
              sessionId: "claude-session",
              timestamp: "2026-01-01T00:00:01Z",
              message: {
                model: "opus",
                content: [
                  {
                    type: "tool_use",
                    id: "tool-1",
                    name: "bash",
                    input: { command: "pwd" },
                  },
                ],
              },
            }),
          line({
            type: "user",
            sessionId: "claude-session",
            timestamp: "2026-01-01T00:00:02Z",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "tool-1", content: "done" },
              ],
            },
          }),
        ],
      }
    },
  },
  {
    name: "codex",
    setup: async () => {
      const home = temp("codex")
      const path = join(
        home,
        ".codex",
        "sessions",
        "2026",
        "01",
        "01",
        "rollout-session.jsonl"
      )
      await mkdir(dirname(path), { recursive: true })
      return {
        provider: new CodexProvider(home),
        path,
        batches: [
          line({
            timestamp: "2026-01-01T00:00:00Z",
            type: "session_meta",
            payload: { id: "codex-session", cwd: "/work" },
          }) +
            line({
              timestamp: "2026-01-01T00:00:01Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "hello" }],
              },
            }) +
            line({
              timestamp: "2026-01-01T00:00:02Z",
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: "tool-1",
                name: "shell",
                arguments: "{}",
              },
            }),
          line({
            timestamp: "2026-01-01T00:00:03Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "tool-1",
              output: "done",
            },
          }),
        ],
      }
    },
  },
  {
    name: "pi",
    setup: async () => {
      const home = temp("pi")
      const path = join(
        home,
        ".pi",
        "agent",
        "sessions",
        "project",
        "session.jsonl"
      )
      await mkdir(dirname(path), { recursive: true })
      return {
        provider: new PiProvider(home),
        path,
        batches: [
          line({ type: "session", id: "pi-session", cwd: "/work" }) +
            line({
              type: "message",
              timestamp: "2026-01-01T00:00:01Z",
              message: { role: "user", content: "hello" },
            }) +
            line({
              type: "message",
              timestamp: "2026-01-01T00:00:02Z",
              message: {
                role: "assistant",
                model: "model",
                content: [
                  {
                    type: "toolCall",
                    id: "tool-1",
                    name: "bash",
                    arguments: { command: "pwd" },
                  },
                ],
              },
            }),
          line({
            type: "message",
            timestamp: "2026-01-01T00:00:03Z",
            message: {
              role: "toolResult",
              toolCallId: "tool-1",
              content: [{ type: "text", text: "done" }],
            },
          }),
        ],
      }
    },
  },
  {
    name: "grok",
    setup: async () => {
      const home = temp("grok")
      const path = join(
        home,
        ".grok",
        "sessions",
        "project",
        "grok-session",
        "chat_history.jsonl"
      )
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        join(dirname(path), "summary.json"),
        JSON.stringify({
          info: { id: "grok-session", cwd: "/work" },
          session_summary: "hello",
        })
      )
      return {
        provider: new GrokProvider(home),
        path,
        batches: [
          line({ type: "user", content: "<user_query>hello</user_query>" }) +
            line({
              type: "assistant",
              content: "",
              tool_calls: [{ id: "tool-1", name: "shell", arguments: "{}" }],
            }),
          line({
            type: "tool_result",
            tool_call_id: "tool-1",
            content: "done",
          }),
        ],
      }
    },
  },
  {
    name: "devin NDJSON",
    setup: async () => {
      const userDir = temp("devin")
      const path = join(userDir, "acp-events", "devin-session.ndjson")
      await mkdir(dirname(path), { recursive: true })
      const notification = (sessionUpdate, fields = {}) =>
        line({ notification: { sessionUpdate, ...fields } })
      return {
        provider: new DevinLocalProvider(userDir),
        path,
        batches: [
          notification("user_message_chunk", {
            content: { text: "hello" },
            _meta: { "cognition.ai/clientMessageId": "user-1" },
          }) +
            notification("tool_call", {
              toolCallId: "tool-1",
              title: "shell",
              rawInput: { command: "pwd" },
            }),
          notification("tool_call_update", {
            toolCallId: "tool-1",
            status: "completed",
            content: { text: "done" },
          }),
        ],
      }
    },
  },
]

async function splitToolResultsConverge() {
  for (const testCase of CASES) {
    const { provider, path, batches } = await testCase.setup()
    await writeFile(path, "")
    const follower = provider.createFollower(path, 0)
    let incremental = []
    for (const [index, batch] of batches.entries()) {
      await appendFile(path, batch)
      const update = await follower.next()
      incremental = apply(incremental, update)
      const full = await provider.read(path)
      assert.ok(
        full,
        `${testCase.name} full read failed after batch ${index + 1}`
      )
      assert.deepEqual(
        incremental,
        full.entries,
        `${testCase.name} incremental output diverged after batch ${index + 1}`
      )
      if (index === 1)
        assert.equal(
          update.replace,
          true,
          `${testCase.name} did not replace its updated tool entry`
        )
    }
    const tool = incremental
      .filter((entry) => entry.kind === "assistant")
      .flatMap((entry) => entry.blocks)
      .find((block) => block.type === "tool")
    assert.equal(
      tool?.output,
      "done",
      `${testCase.name} lost the split tool result`
    )
  }
}

async function midToolFollowConverges() {
  for (const testCase of CASES) {
    const { provider, path, batches } = await testCase.setup()
    await writeFile(path, batches[0])
    const before = await provider.read(path)
    assert.ok(before, `${testCase.name} pre-follow read failed`)
    const follower = provider.createFollower(
      path,
      Buffer.byteLength(batches[0])
    )
    await appendFile(path, batches[1])
    const update = await follower.next()
    const incremental = apply(structuredClone(before.entries), update)
    const full = await provider.read(path)
    assert.ok(full, `${testCase.name} full read failed after late result`)
    assert.deepEqual(
      incremental,
      full.entries,
      `${testCase.name} could not recover a tool opened before follow`
    )
    assert.equal(update.reset, true, `${testCase.name} did not request a boundary reset`)
  }
}

async function catalogFollowConverges() {
  const home = temp("catalog-convergence")
  const dir = join(home, ".pi", "agent", "sessions", "project")
  const path = join(dir, "session.jsonl")
  await mkdir(dir, { recursive: true })
  const initial =
    line({ type: "session", id: "catalog-session", cwd: "/work" }) +
    line({ type: "message", message: { role: "user", content: "hello" } })
  await writeFile(path, initial)
  const provider = new PiProvider(home)
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  const opened = await catalog.open(path)
  assert.ok(opened)
  let incremental = structuredClone(opened.entries)
  const updates = []
  catalog.follow(path, opened.ref.bytes, (entries, replaced, replaceFrom) => {
    updates.push({ entries, replaced, replaceFrom })
    incremental = replaced
      ? [...incremental.slice(0, replaceFrom ?? 0), ...entries]
      : [...incremental, ...entries]
  })

  await appendFile(
    path,
    line({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tool-1", name: "bash", arguments: {} },
        ],
      },
    })
  )
  await refresh(catalog, provider, path)
  assert.deepEqual(incremental, (await provider.read(path)).entries)

  await appendFile(
    path,
    line({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "done" }],
      },
    })
  )
  await refresh(catalog, provider, path)
  assert.equal(updates.at(-1).replaced, true)
  assert.deepEqual(incremental, (await provider.read(path)).entries)
  catalog.stop()
}

async function peekChurn() {
  const root = temp("peek")
  const path = join(root, "session.jsonl")
  await writeFile(path, "seed\n")
  const provider = fileProvider(root)
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  catalog.follow(path, 5, () => {})

  for (const value of ["one", "two", "three"]) {
    await appendFile(path, `${value}\n`)
    await refresh(catalog, provider, path)
  }

  const info = await stat(path)
  const ref = catalog.list()[0]
  assert.equal(provider.peekCalls, 1)
  assert.equal(ref.bytes, info.size)
  assert.equal(ref.updatedAt, new Date(info.mtimeMs).toISOString())
  catalog.stop()
}

async function sharedStoreRescansSerialize() {
  const root = temp("shared-rescan")
  const path = join(root, "sessions.db#session")
  let cursor = 0
  let concurrent = 0
  let maxConcurrent = 0
  let release
  let started
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  const entered = new Promise((resolve) => {
    started = resolve
  })
  const provider = {
    harness: "shared",
    displayName: "Shared",
    rescanRoot: true,
    roots: () => [root],
    discover: async () => [
      { path, bytes: cursor, mtimeMs: cursor },
    ],
    peek: async (file) => ({
      harness: "shared",
      nativeId: "session",
      path,
      bytes: file.bytes,
    }),
    read: async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      started()
      await blocked
      concurrent -= 1
      return {
        ref: { harness: "shared", nativeId: "session", path, bytes: cursor },
        entries: [{ kind: "user", text: String(cursor) }],
      }
    },
  }
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  catalog.follow(path, 0, () => {})
  cursor = 1
  const first = catalog.rescanProvider(provider)
  await entered
  cursor = 2
  const second = catalog.rescanProvider(provider)
  release()
  await Promise.all([first, second])
  assert.equal(maxConcurrent, 1)
  assert.equal(catalog.list()[0]?.bytes, 2)
  catalog.stop()
}

async function entrySinkBoundsMutatedPayloads() {
  const sink = new EntrySink(100, 120)
  sink.push({
    kind: "assistant",
    blocks: [{ type: "tool", name: "shell", output: "x".repeat(200) }],
  })
  sink.push({ kind: "user", text: "latest" })
  const snapshot = sink.snapshot()
  assert.equal(snapshot[0]?.kind, "event")
  assert.equal(snapshot.at(-1)?.kind, "user")
  assert.ok(snapshot.length <= 2)
}

const tests = [
  ["concurrent AB/A refresh race", concurrentRefreshRace],
  ["tail cursor regression", cursorNeverRegresses],
  ["shrink replacement", shrinkReplaces],
  ["split tool result convergence", splitToolResultsConverge],
  ["mid-tool follow convergence", midToolFollowConverges],
  ["catalog full/follow convergence", catalogFollowConverges],
  ["peek-call churn", peekChurn],
  ["shared store rescan serialization", sharedStoreRescansSerialize],
  ["entry sink payload budget", entrySinkBoundsMutatedPayloads],
]

let failed = false
try {
  for (const [name, test] of tests) {
    try {
      await test()
      console.log(`  ok ${name}`)
    } catch (error) {
      failed = true
      console.error(`  not ok ${name}`)
      console.error(error)
    }
  }
} finally {
  for (const path of scratch) rmSync(path, { recursive: true, force: true })
}

if (failed) process.exit(1)
console.log("\nStreaming correctness clean.")
