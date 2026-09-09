import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { applyLiveSnapshot, applyLiveBatch } from "../src/state/live-recovery"
import { acpStore, activeLiveAcp } from "../src/state/acp-state"
import { stagePrompt, removePendingPrompt } from "../src/state/acp-pending"
import { beginStart } from "../src/state/acp-start"
import { promptDelivery } from "../src/state/prompt-delivery"
import { PromptQueue } from "../src/components/composer/prompt-queue"
import type { LiveSnapshot, LiveRequest } from "../src/lib/types"

const id = "11111111-1111-4111-8111-111111111111"
const request: LiveRequest = {
  id: "22222222-2222-4222-8222-222222222222",
  text: "Review the routing changes.",
  attachments: [],
  status: "queued",
}
const snapshot: LiveSnapshot = {
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
  revision: 1,
  createdAt: 1,
  base: null,
  blocks: [],
  requests: [],
  permissions: [],
}
function current() {
  const live = activeLiveAcp(acpStore.get())
  assert.ok(live)
  return live
}
acpStore.set({ activeKey: id })
applyLiveSnapshot(snapshot)
stagePrompt(id, request)
const optimistic = current().projection?.messages[0]
assert.equal(
  optimistic?.blocks[0]?.type === "text"
    ? optimistic.blocks[0].text
    : undefined,
  request.text
)
assert.equal(promptDelivery(current()).queued.length, 0)
assert.equal(
  renderToStaticMarkup(<PromptQueue />),
  "",
  "An idle send has no queue UI before any host call"
)
applyLiveSnapshot({
  ...snapshot,
  revision: 2,
  session: { ...snapshot.session, status: "starting", connection: "starting" },
  requests: [request],
})
assert.equal(current().projection?.messages.length, 1)
assert.equal(current().projection?.messages[0]?.id, optimistic?.id)
assert.equal(current().pendingPrompts?.length, 0)
assert.equal(
  renderToStaticMarkup(<PromptQueue />),
  "",
  "Provider startup must not become a queued-message card"
)
applyLiveBatch({
  id,
  revision: 3,
  updates: [{ kind: "user", requestId: request.id, text: request.text }],
  requests: [{ ...request, status: "dispatching" }],
  session: { ...snapshot.session, status: "running" },
})
assert.equal(current().projection?.messages.length, 1)
assert.equal(
  current().projection?.messages[0]?.id,
  optimistic?.id,
  "Host acknowledgment preserves the message identity"
)
const second = {
  ...request,
  id: "33333333-3333-4333-8333-333333333333",
  text: "Also check keyboard navigation.",
}
stagePrompt(id, second)
assert.equal(
  current().projection?.messages.length,
  1,
  "A follow-up cannot split the active answer"
)
assert.equal(promptDelivery(current()).queued[0]?.id, second.id)
const queue = renderToStaticMarkup(<PromptQueue />)
assert.match(queue, /Up next/)
assert.match(queue, /Also check keyboard navigation/)
assert.match(queue, /Edit queued message/)
assert.match(queue, /Remove queued message/)
removePendingPrompt(id, second.id)
assert.equal(promptDelivery(current()).queued.length, 0)
assert.equal(
  current().projection?.messages.length,
  1,
  "A refused follow-up removes only its own optimistic row"
)
const starting = beginStart({
  harness: "claude",
  cwd: "/disposable",
  blocks: [{ type: "user", text: "First prompt", requestId: request.id }],
  hiddenUserPrompt: null,
})
assert.equal(
  starting.projection?.messages.length,
  1,
  "Fresh conversations show their prompt synchronously"
)
console.log(
  "Prompt delivery: immediate idle prompt, stable startup/ack identity, real follow-ups in one queue, and scoped rejection passed"
)

// Exercise the production send path with settings discovery deliberately unresolved.
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { providers } = await import("../src/state/providers")
const { getMako } = await import("../src/lib/bridge")
const { sendTo } = await import("../src/state/acp-queue")
const { mock } = await import("node:test")
const fixture = installMockBridge()
fixture.setLiveSnapshot(snapshot)
acpStore.set({ activeKey: id })
applyLiveSnapshot({ ...snapshot, revision: 20 })
fixture.setLiveSnapshot({ ...snapshot, revision: 20 })
const bridge = getMako()
const stopEvents = bridge.onEvent((event) => {
  if (event.type === "live-batch") applyLiveBatch(event.batch)
})
const gate = Promise.withResolvers<void>()
const load = providers.load
const delayed = mock.method(
  providers,
  "load",
  async (...args: Parameters<typeof load>) => {
    await gate.promise
    return load(...args)
  }
)
const sent = sendTo(id, "Visible before settings discovery completes")
const pendingBlock = current().projection?.messages.at(-1)?.blocks[0]
assert.equal(
  pendingBlock?.type === "text" ? pendingBlock.text : undefined,
  "Visible before settings discovery completes"
)
assert.equal(renderToStaticMarkup(<PromptQueue />), "")
const visibleId = current().projection?.messages.at(-1)?.id
gate.resolve()
assert.equal(await sent, true)
assert.equal(
  current().projection?.messages.filter((message) => message.role === "user")
    .length,
  1
)
assert.equal(
  current().projection?.messages.find((message) => message.role === "user")?.id,
  visibleId
)
delayed.mock.restore()
const cachedDiscovery = mock.method(providers, "load", async () => {
  throw new Error("Warm send must not discover models")
})
assert.equal(
  await sendTo(id, "Use the settings already shown in the composer"),
  true
)
cachedDiscovery.mock.restore()
stopEvents()
Reflect.deleteProperty(globalThis, "window")
console.log(
  "Production send path paints before awaited discovery and reconciles the acknowledged message without duplicates"
)
