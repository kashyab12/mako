import assert from "node:assert/strict"
import {
  HeadlessRelayWorker,
  RelayEventBatchSchema,
  RelayEventSequencer,
  createMemoryRelayStore,
  parseRelayJobPayload,
  relayDeviceKey,
  relayEventsAfter,
  signRelayToken,
  signRelayTokenRequest,
  verifyRelayToken,
  verifyRelayTokenRequest,
} from "../dist/index.js"

const origin = {
  provider: "slack",
  tenantId: "TTEST",
  conversationId: "CTEST",
  threadId: "123.456",
  eventId: "event-1",
  userId: "UTEST",
}
const deviceSecret = "device-secret".padEnd(64, "x")
const tokenSecret = "token-secret".padEnd(64, "x")
const tokenRequest = {
  tenantId: origin.tenantId,
  deviceId: crypto.randomUUID(),
  nonce: crypto.randomUUID(),
  timestamp: Date.now(),
}
const requestWithSignature = {
  ...tokenRequest,
  signature: signRelayTokenRequest(tokenRequest, deviceSecret),
}
assert.equal(verifyRelayTokenRequest(requestWithSignature, deviceSecret), true)
assert.equal(
  verifyRelayTokenRequest(
    { ...requestWithSignature, signature: requestWithSignature.signature.slice(1) },
    deviceSecret
  ),
  false
)
const nowSeconds = Math.floor(Date.now() / 1_000)
const relayToken = signRelayToken(
  {
    version: 1,
    tenantId: origin.tenantId,
    deviceId: tokenRequest.deviceId,
    scopes: ["relay:read", "relay:write"],
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 300,
  },
  tokenSecret
)
assert.equal(verifyRelayToken(relayToken, tokenSecret)?.deviceId, tokenRequest.deviceId)
assert.equal(verifyRelayToken(`${relayToken}x`, tokenSecret), null)

const payload = parseRelayJobPayload({
  kind: "new",
  forceNew: false,
  origin,
  selection: { harness: "codex" },
  text: "Inspect",
})
assert.equal(payload.origin.conversationId, "CTEST")
assert.throws(() =>
  parseRelayJobPayload({
    ...payload,
    origin: { ...origin, conversationId: "channel' or 1 eq 1" },
  })
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
assert.throws(() =>
  RelayEventBatchSchema.parse({
    deviceId: workerId,
    jobId,
    cursor: second.cursor,
    events: [{ ...second, jobId: crypto.randomUUID() }],
  })
)

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

const memory = createMemoryRelayStore({ failEnqueue: 1 })
const memoryDevice = crypto.randomUUID()
const registeredSecret = await memory.registerDevice({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  deviceName: "memory-worker",
})
assert.deepEqual(
  await memory.deviceKey(origin.tenantId, memoryDevice),
  relayDeviceKey(registeredSecret)
)
const tokenTimestamp = Date.now()
assert.equal(
  await memory.consumeTokenRequest({
    tenantId: origin.tenantId,
    deviceId: memoryDevice,
    nonce: crypto.randomUUID(),
    timestamp: tokenTimestamp,
  }),
  true
)
assert.equal(
  await memory.consumeTokenRequest({
    tenantId: origin.tenantId,
    deviceId: memoryDevice,
    nonce: crypto.randomUUID(),
    timestamp: tokenTimestamp,
  }),
  false
)
await memory.heartbeat(origin.tenantId, {
  defaultHarness: "codex",
  deviceId: memoryDevice,
  deviceName: "memory-worker",
  version: "test",
})
const firstQueued = await memory.enqueue({
  ...payload,
  origin: { ...origin, eventId: "memory-first" },
})
assert.equal((await memory.lease({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  visibilityTimeoutSeconds: 60,
})).kind, "empty")
assert.deepEqual(await memory.reconcile(origin.tenantId), {
  processed: 1,
  failed: 0,
})
const firstLease = await memory.lease({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  visibilityTimeoutSeconds: 60,
})
assert.equal(firstLease.kind, "work")
if (firstLease.kind !== "work") throw new Error("first memory lease missing")
assert.equal(
  await memory.requestStop({ ...origin, eventId: "memory-first" }),
  1
)
assert.deepEqual(
  await memory.control({ deviceId: memoryDevice, jobId: firstQueued.jobId }),
  { kind: "stop" }
)
assert.equal(
  await memory.control({ deviceId: memoryDevice, jobId: firstQueued.jobId }),
  null
)
const secondQueued = await memory.enqueue({
  ...payload,
  origin: { ...origin, eventId: "memory-second" },
})
assert.equal((await memory.lease({
  tenantId: origin.tenantId,
  deviceId: crypto.randomUUID(),
  visibilityTimeoutSeconds: 60,
})).kind, "empty")
const firstCompletion = {
  deviceId: memoryDevice,
  harness: "codex",
  jobId: firstQueued.jobId,
  messageId: firstLease.lease.messageId,
  popReceipt: firstLease.lease.popReceipt,
  progressFailed: false,
  result: "first done",
  status: "done",
  threadPath: "/native/thread",
}
const firstPayload = await memory.recordCompletion(firstCompletion)
await memory.markDelivered({ completion: firstCompletion, payload: firstPayload })
const secondLease = await memory.lease({
  tenantId: origin.tenantId,
  deviceId: memoryDevice,
  visibilityTimeoutSeconds: 60,
})
assert.equal(secondLease.kind, "work")
if (secondLease.kind !== "work") throw new Error("second memory lease missing")
assert.equal(secondLease.lease.jobId, secondQueued.jobId)
assert.equal(secondLease.lease.payload.kind, "resume")
if (secondLease.lease.payload.kind === "resume")
  assert.equal(secondLease.lease.payload.threadPath, "/native/thread")

console.log("relay schemas, auth, cursors, worker, memory store, and reconciliation passed")
