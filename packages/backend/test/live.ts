import assert from "node:assert/strict"
import {
  listSlackChannels,
  slackIdentity,
} from "../src/integrations/slack/client"
import {
  enqueueRelayJob,
  leaseRelayJob,
  markRelayDelivered,
  recordRelayCompletion,
} from "../src/relay/storage"
import { RelayCompletionSchema } from "../src/relay/types"

const identity = await slackIdentity()
assert.equal(identity.ok, true)
assert.ok(identity.team_id)
assert.ok(identity.bot_id || identity.user_id)

const channels = await listSlackChannels({ limit: 1 })
assert.equal(channels.ok, true)
assert.ok(Array.isArray(channels.channels))

const deviceId = crypto.randomUUID()
const queued = await enqueueRelayJob({
  kind: "new",
  selection: { harness: "codex" },
  origin: {
    provider: "slack",
    tenantId: "TTEST",
    conversationId: "CTEST",
    threadId: "123.456",
    eventId: `test-${crypto.randomUUID()}`,
    userId: "UTEST",
  },
  text: "relay probe",
})
const leased = await leaseRelayJob({
  tenantId: "TTEST",
  deviceId,
  visibilityTimeoutSeconds: 60,
})
assert.equal(leased.kind, "work")
if (leased.kind !== "work") throw new Error("Relay probe was not leased")
assert.equal(leased.lease.jobId, queued.jobId)
const completion = RelayCompletionSchema.parse({
  deviceId,
  harness: "codex",
  jobId: leased.lease.jobId,
  messageId: leased.lease.messageId,
  popReceipt: leased.lease.popReceipt,
  result: "relay probe complete",
  threadPath: "/tmp/mako-relay-probe",
})
const payload = await recordRelayCompletion(completion)
await markRelayDelivered({ completion, payload })

console.log("Live Slack and Azure durable relay checks passed")
