import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import { reduceLiveUpdates } from "../electron/contracts/live-content.js"
import type { LiveSessionState, HostEvent } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { projectLive } from "../src/state/live-projection.js"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mako-live-test-"))
  const id = randomUUID()
  const state: LiveSessionState = {
    id,
    nativeId: "native-1",
    harness: "test-provider",
    cwd: "/tmp",
    status: "ready",
    connection: "connected",
    modes: [],
    currentMode: null,
    configOptions: [],
  }
  const started = deferred<LiveSessionState>()
  const sent: string[] = []
  const prompts: ReturnType<typeof deferred<void>>[] = []
  const events: HostEvent[] = []
  let closed = 0
  const driver: ProviderLiveDriver = {
    canResume: true,
    provider: "test-provider",
    available: () => true,
    start: () => started.promise,
    prompt: async (_id, text) => {
      sent.push(text)
      const pending = deferred<void>()
      prompts.push(pending)
      await pending.promise
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {
      closed++
    },
    setMode: async () => {},
  }
  const dependencies = {
    appPath: root,
    root,
    driver: () => driver,
    history: async () => null,
    emit: (event: HostEvent) => events.push(event),
  }
  const owner = new LiveConversations(dependencies)
  return {
    root,
    id,
    state,
    started,
    sent,
    prompts,
    events,
    owner,
    dependencies,
    closed: () => closed,
    cleanup: () => {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function acceptanceAndRaces() {
  const f = fixture()
  try {
    const requestId = randomUUID()
    await f.owner.start("test-provider", "/tmp", {
      conversationId: f.id,
      initialRequest: { id: requestId, text: "first", attachments: [] },
    })
    assert.equal(f.owner.snapshot(f.id)?.requests[0]?.status, "queued")
    assert.deepEqual(f.sent, [])
    f.owner.submit(f.id, requestId, "first")
    assert.throws(
      () => f.owner.submit(f.id, requestId, "different"),
      /different content/
    )
    f.started.resolve(f.state)
    await tick()
    assert.deepEqual(f.sent, ["first"])
    f.owner.observe({
      type: "acp-session",
      session: { ...f.state, status: "running" },
    })
    const second = randomUUID()
    f.owner.submit(f.id, second, "second")
    f.owner.observe({
      type: "acp-update",
      id: f.id,
      update: { kind: "text", id: "item", text: "par" },
    })
    f.owner.observe({
      type: "acp-update",
      id: f.id,
      update: { kind: "text", id: "item", text: "corrected", replace: true },
    })
    f.owner.observe({ type: "acp-session", session: f.state })
    assert.deepEqual(f.sent, ["first", "second"])
    f.owner.observe({
      type: "acp-session",
      session: { ...f.state, status: "running" },
    })
    f.prompts[0]!.reject(new Error("late first response"))
    await tick()
    assert.equal(f.owner.snapshot(f.id)?.session.status, "running")
    assert.equal(f.owner.snapshot(f.id)?.requests[1]?.status, "dispatching")
    assert.equal(
      f.owner.snapshot(f.id)?.blocks.find((block) => block.type === "text")
        ?.text,
      "corrected"
    )
    f.owner.submit(f.id, second, "second")
    assert.equal(f.sent.length, 2)
  } finally {
    f.cleanup()
  }
}

async function closeDuringStartup() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.owner.close(f.id)
    f.started.resolve(f.state)
    await tick()
    assert.equal(f.owner.snapshot(f.id)?.session.status, "closed")
    assert.ok(f.closed() >= 1)
  } finally {
    f.cleanup()
  }
}

async function durabilityAndBatching() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    f.events.length = 0
    for (let index = 0; index < 1000; index++)
      f.owner.observe({
        type: "acp-update",
        id: f.id,
        update: { kind: "text", text: "ha" },
      })
    const fault = mock.method(LiveJournal.prototype, "commit", () => {
      throw new Error("disk unavailable")
    })
    assert.throws(() => f.owner.snapshot(f.id), /disk unavailable/)
    fault.mock.restore()
    const snapshot = f.owner.snapshot(f.id)!
    assert.equal(
      snapshot.blocks[0]?.type === "text" ? snapshot.blocks[0].text : "",
      "ha".repeat(1000)
    )
    const batches = f.events.filter((event) => event.type === "live-batch")
    assert.ok(batches.length <= 9, `${batches.length} batches for 1,000 chunks`)
    assert.ok(batches.every((event) => event.batch.updates.length <= 128))
    f.owner.submit(f.id, randomUUID(), "running")
    f.owner.observe({
      type: "acp-session",
      session: { ...f.state, status: "running" },
    })
    f.owner.submit(f.id, randomUUID(), "waiting")
    f.owner.stop()
    const recovered = new LiveConversations(f.dependencies)
    try {
      const saved = recovered.snapshot(f.id)!
      assert.equal(saved.requests[0]?.status, "uncertain")
      assert.equal(saved.requests[1]?.status, "queued")
      assert.equal(saved.requests[1]?.text, "waiting")
      assert.equal(
        JSON.stringify(saved.blocks),
        JSON.stringify(
          snapshot.blocks.concat([
            { type: "user", provider: "test-provider", requestId: saved.requests[0]?.id, contextFiles: [], text: "running", attachments: [] },
          ])
        )
      )
      assert.equal(f.sent.length, 1)
    } finally {
      recovered.stop()
    }
  } finally {
    f.cleanup()
  }
}

function identityAndToolLifecycle() {
  const f = fixture()
  try {
    let blocks = reduceLiveUpdates(
      [],
      [
        { kind: "user", text: "same" },
        {
          kind: "tool",
          id: "tool",
          title: "Read",
          status: "completed",
          output: "first",
        },
        { kind: "user", text: "same" },
        {
          kind: "tool",
          id: "tool",
          title: "Read",
          status: "in_progress",
          output: "partial",
        },
        {
          kind: "tool-update",
          id: "tool",
          output: "more",
          status: "in_progress",
        },
      ]
    )
    assert.equal(blocks[1]?.type === "tool" ? blocks[1].output : "", "first")
    const tools = projectLive({ session: f.state, blocks, base: null })
      .messages.flatMap((message) => message.blocks)
      .filter((block) => block.type === "toolResult")
    assert.equal(tools[1]?.streaming, true)
    blocks = []
    for (let index = 0; index < 500; index++)
      blocks = reduceLiveUpdates(blocks, [
        { kind: "user", text: `${index}` },
        { kind: "text", text: "answer" },
      ])
    const first = projectLive({ session: f.state, blocks, base: null })
    const next = projectLive(
      {
        session: f.state,
        blocks: reduceLiveUpdates(blocks, [{ kind: "text", text: "!" }]),
        base: null,
      },
      first
    )
    assert.equal(
      next.exchanges.filter(
        (exchange, index) => exchange === first.exchanges[index]
      ).length,
      499
    )
  } finally {
    f.cleanup()
  }
}

async function failureIsolationAndAssets() {
  const f = fixture()
  try {
    await f.owner.start("test-provider", "/tmp", { conversationId: f.id })
    f.started.resolve(f.state)
    await tick()
    const fault = mock.method(LiveJournal.prototype, "commit", () => {
      throw new Error("disk unavailable")
    })
    assert.throws(
      () => f.owner.submit(f.id, randomUUID(), "rejected"),
      /disk unavailable/
    )
    fault.mock.restore()
    f.owner.observe({ type: "acp-session", session: { ...f.state } })
    assert.deepEqual(f.sent, [], "rejected acceptance cannot execute later")
    const long = "abcdefgh".repeat(50_000)
    f.owner.observe({
      type: "acp-update",
      id: f.id,
      update: { kind: "text", text: long, id: "large-answer" },
    })
    f.owner.observe({
      type: "acp-update",
      id: f.id,
      update: {
        kind: "tool",
        id: "large-tool",
        title: "Read",
        status: "completed",
        output: long,
      },
    })
    const snapshot = f.owner.snapshot(f.id)!
    assert.equal(
      snapshot.blocks.find((block) => block.type === "text")?.text,
      long
    )
    const tool = snapshot.blocks.find((block) => block.type === "tool")
    const source = tool?.attachments?.[0]?.source
    assert.ok(source?.kind === "file")
    assert.equal(readFileSync(source.path, "utf8"), long)
    assert.ok((tool?.output?.length ?? Infinity) < 65_000)
    assert.ok(
      f.events
        .filter((event) => event.type === "live-batch")
        .every((event) => JSON.stringify(event.batch.updates).length < 256_000)
    )
    f.owner.stop()
    writeFileSync(join(f.root, `${randomUUID()}.sqlite`), "corrupt journal")
    const recovered = new LiveConversations(f.dependencies)
    try {
      assert.equal(recovered.snapshot(f.id)?.blocks.length, 2)
      assert.ok(
        f.events.some(
          (event) =>
            event.type === "notice" &&
            event.message.includes("preserved for recovery")
        )
      )
    } finally {
      recovered.stop()
    }
  } finally {
    f.cleanup()
  }
}

await failureIsolationAndAssets()

await acceptanceAndRaces()
await closeDuringStartup()
await durabilityAndBatching()
identityAndToolLifecycle()
console.log(
  "Live conversations: durable deduplicated acceptance, startup/terminal races, recovery, batching, tool lifecycle, and 499/499 completed exchange identities passed"
)
