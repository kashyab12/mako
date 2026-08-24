import assert from "node:assert/strict"
import {
  appendFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { SessionCatalog } from "../dist/catalog.js"
import { EntrySink } from "../dist/format.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { DevinLocalProvider } from "../dist/providers/devin-local.js"
import { emitCursorSession } from "../dist/emit.js"
import { GrokProvider } from "../dist/providers/grok.js"

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

async function pagedTailIsBoundedAndComplete() {
  const root = temp("paging")
  const path = join(root, "session.jsonl")
  await writeFile(
    path,
    Array.from({ length: 250 }, (_, index) => `entry-${index}`).join("\n") + "\n"
  )
  const catalog = new SessionCatalog([fileProvider(root)])
  await catalog.scan()
  const tail = await catalog.page(path)
  assert.equal(tail.entries.length, 100)
  assert.equal(tail.start, 150)
  assert.equal(tail.total, 250)
  assert.equal(tail.hasEarlier, true)
  const middle = await catalog.page(path, tail.start)
  const first = await catalog.page(path, middle.start)
  assert.deepEqual(
    [...first.entries, ...middle.entries, ...tail.entries].map((entry) => entry.text),
    Array.from({ length: 250 }, (_, index) => `entry-${index}`)
  )
  assert.equal(first.hasEarlier, false)
  catalog.stop()
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
                  { type: "thinking", thinking: "checking the tool" },
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
              timestamp: "2026-01-01T00:00:01.500Z",
              type: "response_item",
              payload: {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "checking the tool" }],
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
    if (testCase.name === "claude" || testCase.name === "codex") {
      const thinking = incremental
        .filter((entry) => entry.kind === "assistant")
        .flatMap((entry) => entry.blocks)
        .find((block) => block.type === "thinking")
      assert.equal(thinking?.text, "checking the tool")
    }
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

async function codexLifecycleMarkersSurvive() {
  const home = temp("codex-lifecycle")
  const path = join(
    home,
    ".codex",
    "sessions",
    "2026",
    "01",
    "01",
    "rollout-lifecycle.jsonl"
  )
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    line({
      type: "session_meta",
      payload: { id: "lifecycle", cwd: "/work" },
    }) +
      line({
        type: "event_msg",
        payload: { type: "context_compacted" },
      }) +
      line({
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "user" },
      })
  )
  const thread = await new CodexProvider(home).read(path)
  assert.deepEqual(
    thread?.entries.filter((entry) => entry.kind === "event"),
    [
      { kind: "event", label: "Context compacted" },
      { kind: "event", label: "Interrupted", detail: "user" },
    ]
  )
}

async function claudeInterruptedMarkerSurvives() {
  const home = temp("claude-interrupted")
  const path = join(home, ".claude", "projects", "p", "interrupted.jsonl")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    line({
      type: "user",
      sessionId: "interrupted",
      cwd: "/work",
      message: { content: "start" },
    }) +
      line({
        type: "assistant",
        sessionId: "interrupted",
        isAbortedMidStream: true,
        message: {
          model: "opus",
          content: [{ type: "text", text: "partial" }],
        },
      })
  )
  const thread = await new ClaudeProvider(home).read(path)
  assert.equal(
    thread?.entries.some(
      (entry) => entry.kind === "event" && entry.label === "Interrupted"
    ),
    true
  )
}

async function cursorWatcherDeliversReplacement() {
  const home = temp("cursor-watch")
  const emitted = await emitCursorSession(
    {
      ref: {
        harness: "cursor",
        nativeId: "source",
        path: "/source",
        cwd: "/work",
        title: "Cursor watch",
      },
      entries: [
        { kind: "user", text: "one" },
        {
          kind: "assistant",
          blocks: [{ type: "text", text: "answer" }],
        },
      ],
    },
    { cwd: "/work", home }
  )
  const provider = new CursorProvider(home)
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  const opened = await catalog.open(emitted.path)
  assert.ok(opened)
  const delivered = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Cursor database update was not delivered")),
      2_000
    )
    catalog.follow(emitted.path, opened.ref.bytes, (entries, replaced) => {
      if (
        !entries.some(
          (entry) => entry.kind === "user" && entry.text === "two"
        )
      ) {
        return
      }
      clearTimeout(timer)
      resolve({ entries, replaced })
    })
  })
  catalog.startWatching()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const database = new DatabaseSync(emitted.path)
  const rows = database.prepare("SELECT id, data FROM blobs").all()
  const user = rows.find((row) =>
    Buffer.from(row.data).toString("utf8").includes("<user_query>")
  )
  assert.ok(user)
  const updated = Buffer.from(rowText(user).replace("one", "two"))
  database.prepare("UPDATE blobs SET data = ? WHERE id = ?").run(updated, user.id)
  database.close()
  const update = await delivered
  assert.equal(update.replaced, true)
  assert.equal(
    update.entries.some(
      (entry) => entry.kind === "user" && entry.text === "two"
    ),
    true
  )
  catalog.stop()
}

function rowText(row) {
  return Buffer.from(row.data).toString("utf8")
}

async function catalogCanonicalizesWorkspaceRoots() {
  const project = temp("workspace-root")
  const nested = join(project, "packages", "app")
  const path = join(project, "session.jsonl")
  await mkdir(join(project, ".git"), { recursive: true })
  await mkdir(nested, { recursive: true })
  await writeFile(path, "session\n")
  const base = fileProvider(project)
  let reads = 0
  const provider = {
    ...base,
    peek: async (file) => ({
      harness: "test",
      nativeId: "workspace-session",
      path: file.path,
      cwd: nested,
      bytes: file.bytes,
      updatedAt: new Date(file.mtimeMs).toISOString(),
    }),
    read: async (file) => {
      reads += 1
      const thread = await base.read(file)
      return { ...thread, ref: { ...thread.ref, cwd: nested } }
    },
  }
  const catalog = new SessionCatalog([provider])
  const workspace = realpathSync(project)
  const [ref] = await catalog.scan()
  assert.equal(ref.workspace, workspace)
  const opened = await catalog.open(path)
  assert.equal(opened?.ref.workspace, workspace)
  assert.equal((await catalog.open(path))?.ref.workspace, workspace)
  assert.equal(reads, 1)
  catalog.stop()
}

async function externalWatcherDeliversAppend() {
  const root = temp("external-watch")
  const path = join(root, "session.jsonl")
  await writeFile(path, "initial\n")
  const provider = fileProvider(root)
  const catalog = new SessionCatalog([provider])
  await catalog.scan()
  const delivered = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("external file update was not delivered")),
      2_000
    )
    catalog.follow(path, Buffer.byteLength("initial\n"), (entries) => {
      clearTimeout(timer)
      resolve(entries)
    })
  })
  catalog.startWatching()
  await new Promise((resolve) => setTimeout(resolve, 50))
  await appendFile(path, "external\n")
  assert.deepEqual(await delivered, [{ kind: "user", text: "external" }])
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
  ["bounded complete timeline paging", pagedTailIsBoundedAndComplete],
  ["concurrent AB/A refresh race", concurrentRefreshRace],
  ["tail cursor regression", cursorNeverRegresses],
  ["split tool result convergence", splitToolResultsConverge],
  ["mid-tool follow convergence", midToolFollowConverges],
  ["peek-call churn", peekChurn],
  ["shared store rescan serialization", sharedStoreRescansSerialize],
  ["Codex lifecycle markers", codexLifecycleMarkersSurvive],
  ["Claude interruption marker", claudeInterruptedMarkerSurvives],
  ["Cursor watcher replacement delivery", cursorWatcherDeliversReplacement],
  ["canonical workspace roots", catalogCanonicalizesWorkspaceRoots],
  ["external watcher append delivery", externalWatcherDeliversAppend],
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
