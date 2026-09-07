import assert from "node:assert/strict"
import { BrowserService } from "../electron/browser-service.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
  BrowserFault,
} from "../electron/contracts/browser-control.js"
import { startControlService } from "../electron/control-service.js"
import { browserControlClient } from "../electron/browser-control-client.js"
import { browserFixture } from "./browser-control-fixture.js"

const fixture = await browserFixture()
const service = new BrowserService([fixture.definition])
let authorized = true
const control = await startControlService(service, () => {
  if (!authorized) throw new Error("Binding is no longer active")
})
const credentials = control.mint("task-a", "binding-a")
const remote = browserControlClient({
  MAKO_CONTROL_URL: credentials.url,
  MAKO_CONTROL_TOKEN: credentials.token,
})
const run = (
  owner: string,
  input: Parameters<typeof BrowserCommandSchema.parse>[0],
  signal = new AbortController().signal
) => service.execute(owner, BrowserCommandSchema.parse(input), signal)
try {
  assert.equal(fixture.connections(), 0)
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      run(`task-${i}`, { action: "connect", browser: "fixture" })
    )
  )
  assert.equal(
    fixture.connections(),
    1,
    "Ten tasks must share one Chrome connection"
  )
  const a = BrowserTargetSchema.parse(
    await run("task-a", { action: "open", browser: "fixture" })
  )
  const b = BrowserTargetSchema.parse(
    await run("task-b", { action: "open", browser: "fixture" })
  )
  assert.notEqual(a.tab, b.tab)
  await Promise.all([
    run("task-a", { action: "type", target: a, text: "a" }),
    run("task-b", { action: "type", target: b, text: "b" }),
  ])
  const inputCalls = fixture.calls.filter(
    (call) => call.method === "Input.insertText"
  )
  assert.notEqual(inputCalls[0].sessionId, inputCalls[1].sessionId)
  await assert.rejects(
    run("task-b", { action: "type", target: a, text: "wrong" }),
    /another task/
  )
  const rejectedBeforeDispatch = fixture.calls.length
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    run(
      "task-a",
      { action: "type", target: a, text: "cancelled" },
      cancelled.signal
    )
  )
  assert.equal(fixture.calls.length, rejectedBeforeDispatch)
  const delayedAbort = new AbortController()
  const delayed = run(
    "task-a",
    { action: "type", target: a, text: "delay" },
    delayedAbort.signal
  )
  const rejected = assert.rejects(
    delayed,
    (error: Error) =>
      error instanceof BrowserFault && error.detail.outcome === "unknown"
  )
  for (
    let count = 0;
    !fixture.calls.some((call) => call.params.text === "delay");
    count++
  ) {
    assert.ok(count < 100)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const concurrent = await run("task-a", {
    action: "cdp",
    target: a,
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
    concurrent: true,
  })
  assert.ok(concurrent)
  await assert.rejects(
    run("task-b", {
      action: "select",
      browser: "fixture",
      tab: a.tab,
      takeover: true,
    }),
    /Another task/
  )
  delayedAbort.abort()
  await rejected
  await assert.rejects(
    run("task-a", { action: "type", target: a, text: "retry" }),
    /outcome is unknown/
  )
  fixture.completeDelayed()
  await run("task-a", { action: "observe", target: a })
  await run("task-a", { action: "type", target: a, text: "after-observation" })
  assert.equal(
    fixture.calls.filter((call) => call.params.text === "delay").length,
    1
  )
  fixture.targets.delete(a.tab)
  await assert.rejects(
    run("task-a", { action: "type", target: a, text: "closed" }),
    /No command was retried/
  )
  assert.equal(
    fixture.calls.filter((call) => call.params.text === "closed").length,
    1
  )
  assert.ok(!fixture.calls.some((call) => call.params.text === "wrong"))
  await run("task-b", { action: "type", target: b, text: "b-still-works" })
  const old = b
  await run("task-b", { action: "release", target: b })
  const contenders = await Promise.allSettled([
    run("task-c", { action: "select", browser: "fixture", tab: b.tab }),
    run("task-d", { action: "select", browser: "fixture", tab: b.tab }),
  ])
  assert.equal(
    contenders.filter((result) => result.status === "fulfilled").length,
    1
  )
  const reclaimed = BrowserTargetSchema.parse(
    await run("task-b", {
      action: "select",
      browser: "fixture",
      tab: b.tab,
      takeover: true,
    })
  )
  assert.notEqual(reclaimed.lease, old.lease)
  await assert.rejects(
    run("task-b", { action: "type", target: old, text: "old-lease" }),
    /earlier claim/
  )
  assert.equal(fixture.connections(), 1)
  await remote({ action: "status" }, new AbortController().signal)
  const replaced = browserControlClient({
    MAKO_CONTROL_URL: credentials.url,
    MAKO_CONTROL_TOKEN: credentials.token,
  })
  await replaced({ action: "status" }, new AbortController().signal)
  assert.equal(
    fixture.connections(),
    1,
    "Replacing an MCP client must not disconnect Chrome"
  )
  authorized = false
  await assert.rejects(
    remote(
      { action: "tabs", browser: "fixture" },
      new AbortController().signal
    ),
    /no longer active/
  )
  service.disconnect("fixture")
  assert.equal(service.status()[0].connection.status, "disconnected")
  await run("task-b", { action: "connect", browser: "fixture" })
  await assert.rejects(
    run("task-b", {
      action: "type",
      target: reclaimed,
      text: "stale-generation",
    }),
    /earlier Chrome connection/
  )
  assert.equal(fixture.connections(), 2)
  console.log(
    "Browser service: one connection for ten tasks; exact targets, serialized claims, stale leases, cancellation uncertainty, no retarget/replay, restart generations and binding authorization verified"
  )
} finally {
  control.close()
  await fixture.close()
}
