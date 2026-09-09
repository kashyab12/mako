import { ProposedPlanCard } from "../src/components/transcript/proposed-plan"
import { TranscriptSourceContext } from "../src/components/transcript/source-context"
import { draftPlanReply } from "../src/state/plans"
import {
  draftText,
  rememberDraft,
  draftsStore,
  clearCapturedDraft,
  restoreEmptyDraft,
  retainRejectedDraft,
  takeRejectedDraft,
  appendRecoveredDraft,
} from "../src/state/drafts"
import { AgentRow } from "../src/components/inspector/agents-panel"
import { applyLiveSnapshot, applyLiveBatch } from "../src/state/live-recovery"
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { acpStore, type LiveAcpConversation } from "../src/state/acp"
import { LiveActionStatus } from "../src/components/viewer/live-action-status"
import { TransferStatus } from "../src/components/viewer/transfer-status"
import { ConversationRelations } from "../src/components/viewer/conversation-relations"

const id = "11111111-1111-4111-8111-111111111111"
const control: NonNullable<LiveAcpConversation["control"]> = {
  activeBindingId: id,
  bindings: [],
  children: [],
  merges: [],
  transfers: [],
  actions: [],
}
const conversation: LiveAcpConversation = {
  key: id,
  draftKey: id,
  kind: "live",
  harness: "claude",
  cwd: "/disposable",
  blocks: [],
  queued: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  permission: null,
  sending: false,
  canceling: false,
  control,
  session: {
    id,
    harness: "claude",
    cwd: "/disposable",
    connection: "connected",
    status: "ready",
    modes: [],
    currentMode: null,
    configOptions: [],
  },
}
function publish() {
  acpStore.set({
    activeKey: id,
    conversations: { [id]: { ...conversation, control: { ...control } } },
  })
}
control.actions = [
  {
    input: { kind: "compact", id },
    digest: "test",
    bindingId: id,
    createdAt: 1,
    state: { kind: "completed" },
  },
]
publish()
assert.equal(renderToStaticMarkup(<LiveActionStatus />), "")
assert.match(
  renderToStaticMarkup(<LiveActionStatus history />),
  /Compaction completed/
)
control.actions[0]!.state = { kind: "accepted" }
publish()
assert.match(renderToStaticMarkup(<LiveActionStatus />), /Compaction accepted/)
control.actions[0]!.state = {
  kind: "uncertain",
  reason: "Connection lost after dispatch",
}
publish()
assert.match(
  renderToStaticMarkup(<LiveActionStatus />),
  /Disconnect and keep history/
)
assert.match(
  renderToStaticMarkup(<LiveActionStatus />),
  /Connection lost after dispatch/
)
control.transfers = [
  {
    input: { id, provider: "claude", text: "saved request", attachments: [] },
    createdAt: 1,
    state: {
      kind: "accepted",
      bindingId: id,
      manifest: {
        file: "/disposable/context.md",
        digest: "test",
        sourceRevision: 1,
        fromBlock: 0,
        toBlock: 1,
        includesBase: true,
        losses: [],
      },
    },
  },
]
publish()
assert.equal(renderToStaticMarkup(<TransferStatus />), "")
assert.match(
  renderToStaticMarkup(<TransferStatus history />),
  /Inspect transferred context/
)
control.transfers[0]!.state = {
  kind: "uncertain",
  error: "Acceptance not confirmed",
}
publish()
assert.match(
  renderToStaticMarkup(<TransferStatus />),
  /Acceptance not confirmed/
)
assert.match(renderToStaticMarkup(<TransferStatus />), /saved request/)
control.ancestry = {
  kind: "fork",
  parentId: id,
  sourceRevision: 1,
  point: "before",
}
publish()
const relations = renderToStaticMarkup(<ConversationRelations />)
assert.match(relations, />Delegate</)
assert.doesNotMatch(relations, /<textarea|<form|<select/)
console.log(
  "Rendered controls: completed receipts are on demand; pending/uncertain actions and saved input remain visible; the closed task dialog adds no form to the transcript"
)

const nativeAgent = {
  nativeId: "child",
  bindingId: id,
  provider: "claude",
  title: "Inspect routing",
  observedAt: 1,
  state: { kind: "completed" as const, summary: "Found the route" },
  usage: { tokens: 100, toolUses: 2 },
}
const row = renderToStaticMarkup(<AgentRow agent={nativeAgent} />)
assert.match(row, /Found the route/)
assert.match(row, /100 tokens/)
assert.match(row, /2 tools used/)
assert.match(row, /aria-expanded="false"/)
applyLiveSnapshot({
  session: conversation.session,
  blocks: [],
  requests: [],
  permissions: [],
  revision: 1,
  createdAt: 1,
  base: null,
})
const beforeAgents = acpStore.get().conversations[id]
assert.ok(beforeAgents?.kind === "live")
applyLiveBatch({
  id,
  revision: 2,
  updates: [],
  nativeAgents: { agents: [nativeAgent], limited: false },
})
const afterAgents = acpStore.get().conversations[id]
assert.ok(afterAgents?.kind === "live")
assert.equal(
  afterAgents.projection,
  beforeAgents.projection,
  "Agent-only events must preserve the transcript projection"
)
assert.equal(afterAgents.nativeAgents?.agents[0]?.nativeId, "child")
console.log(
  "Agent details render; agent-only batches preserve the transcript projection"
)

const proposal = {
  type: "proposed-plan" as const,
  id: "plan-1",
  text: "# Route recovery\n\nKeep the requested destination.",
  status: "proposed" as const,
}
const planCard = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: id }}>
    <ProposedPlanCard plan={proposal} />
  </TranscriptSourceContext>
)
assert.match(planCard, /Route recovery/)
assert.match(planCard, /Draft implementation/)
assert.match(planCard, /aria-expanded="false"/)
rememberDraft(id, "Also preserve accessibility.")
draftPlanReply({ liveId: id }, proposal, "implement")
const preparedPlan = draftText(id)
assert.ok(preparedPlan.startsWith("Also preserve accessibility."))
assert.ok(!preparedPlan.includes(proposal.text))
assert.equal(
  draftsStore.get().drafts.find((entry) => entry.key === id)?.plans?.[0]?.text,
  proposal.text
)
draftPlanReply({ liveId: id }, proposal, "implement")
assert.equal(
  draftText(id),
  preparedPlan,
  "Repeated clicks must not duplicate the same prepared reply"
)
assert.throws(
  () => draftPlanReply({ liveId: "other" }, proposal, "implement"),
  /Open the plan's conversation/
)
assert.equal(draftText(id), preparedPlan)
draftPlanReply({ liveId: id }, proposal, "revise")
assert.ok(draftText(id).startsWith("Also preserve accessibility."))
assert.ok(!draftText(id).includes("Implement the proposed plan:"))
assert.ok(
  draftText(id).includes("Keep planning until I approve implementation.")
)
draftPlanReply({ liveId: id }, proposal, "implement")
assert.equal(draftText(id), preparedPlan)
assert.throws(
  () =>
    draftPlanReply(
      { liveId: id },
      { ...proposal, truncated: true },
      "implement"
    ),
  /complete plan/
)
console.log(
  "Plan reply preparation preserves existing drafts, rejects stale conversations, and avoids duplicate insertion"
)

const planDraft = draftsStore.get().drafts.find((entry) => entry.key === id)
assert.ok(planDraft)
rememberDraft(id, "A newer paragraph")
clearCapturedDraft(id, planDraft.text, planDraft.plans)
assert.equal(draftText(id), "A newer paragraph")
assert.equal(restoreEmptyDraft(id, planDraft.text, planDraft.plans), false)
retainRejectedDraft(id, planDraft.text, [], planDraft.plans)
const rejectedPlan = draftsStore.get().rejected.at(-1)
assert.ok(rejectedPlan)
const recoveredPlan = takeRejectedDraft(rejectedPlan.id)
assert.ok(recoveredPlan)
appendRecoveredDraft(id, recoveredPlan)
assert.ok(draftText(id).startsWith("A newer paragraph"))
assert.equal(
  draftsStore.get().drafts.find((entry) => entry.key === id)?.plans?.[0]?.text,
  proposal.text
)
const finalDraft = draftsStore.get().drafts.find((entry) => entry.key === id)
assert.ok(finalDraft)
clearCapturedDraft(id, finalDraft.text, finalDraft.plans)
assert.equal(
  draftsStore.get().drafts.find((entry) => entry.key === id),
  undefined
)
assert.equal(restoreEmptyDraft(id, finalDraft.text, finalDraft.plans), true)
console.log(
  "Plan context survives refused sends and newer edits; accepted sends clear only their own captured draft"
)
