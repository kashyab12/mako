import assert from "node:assert/strict"
import {
  HeadlessRelayWorker,
  RelayEventSequencer,
  parseRelayJobPayload,
  relayEventsAfter,
} from "../dist/index.js"

const origin = {
  provider: "slack",
  tenantId: "TTEST",
  conversationId: "CTEST",
  threadId: "123.456",
  eventId: "event-1",
  userId: "UTEST",
}
const payload = parseRelayJobPayload({
  kind: "new",
  forceNew: false,
  origin,
  selection: { harness: "codex" },
  text: "Inspect",
})
assert.equal(payload.origin.conversationId, "CTEST")
assert.equal(
  parseRelayJobPayload({
    kind: "new",
    slack: {
      channel: "CTEST",
      eventId: "event-old",
      teamId: "TTEST",
      threadTs: "123.456",
      userId: "UTEST",
    },
    selection: {},
    text: "Legacy",
  }).origin.provider,
  "slack"
)

const workerId = crypto.randomUUID()
const epoch = crypto.randomUUID()
const jobId = crypto.randomUUID()
const sequencer = new RelayEventSequencer(workerId, epoch)
const first = sequencer.next(jobId, { kind: "lifecycle", status: "starting" })
const second = sequencer.next(jobId, {
  kind: "tool",
  id: "tool-1",
  title: "Read file",
  status: "in_progress",
})
assert.equal(first.jobSeq, 1)
assert.equal(second.jobSeq, 2)
assert.deepEqual(relayEventsAfter([second, first], first.cursor), [second])

const lease = {
  jobId,
  messageId: "message-1",
  payload,
  popReceipt: "receipt-1",
}
const batches = []
const completions = []
const worker = new HeadlessRelayWorker(
  {
    async lease() {
      return lease
    },
    async renew(current) {
      return current.popReceipt
    },
    async sendEvents(batch) {
      batches.push(batch)
    },
    async control() {
      return null
    },
    async complete(completion) {
      completions.push(completion)
    },
  },
  {
    async execute(_lease, context) {
      context.emit({ kind: "reasoning", id: "reasoning", status: "in_progress" })
      context.emit({
        kind: "tool",
        id: "tool-1",
        title: "Read file",
        status: "completed",
      })
      context.emit({ kind: "text", text: "Done" })
      return {
        harness: "codex",
        result: "Done",
        status: "done",
        threadPath: "/thread",
      }
    },
  },
  {
    heartbeat: {
      defaultHarness: "codex",
      deviceId: workerId,
      deviceName: "test-worker",
      version: "test",
    },
    eventFlushMs: 0,
  }
)
assert.equal(await worker.runOnce(), true)
assert.equal(completions.length, 1)
assert.equal(completions[0].status, "done")
assert.deepEqual(
  batches.flatMap((batch) => batch.events).map((entry) => entry.event.kind),
  ["lifecycle", "reasoning", "tool", "text", "lifecycle"]
)

console.log("relay schemas, cursors, canonical events, and headless worker passed")
