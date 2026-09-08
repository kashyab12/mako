import assert from "node:assert/strict"
import { BrowserService } from "../electron/browser-service.js"
import { ControlPreviews } from "../electron/control-previews.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
} from "../electron/contracts/browser-control.js"
import { browserFixture } from "./browser-control-fixture.js"

const fixture = await browserFixture()
const browser = new BrowserService([fixture.definition])
let events = 0
const previews = new ControlPreviews(
  browser,
  (image) => image,
  () => {
    events++
  }
)
const run = (input: Parameters<typeof BrowserCommandSchema.parse>[0]) =>
  browser.execute(
    "task",
    BrowserCommandSchema.parse(input),
    AbortSignal.timeout(1000)
  )
try {
  await run({ action: "connect", browser: "fixture" })
  const target = BrowserTargetSchema.parse(
    await run({ action: "open", browser: "fixture" })
  )
  const activity = {
    conversationId: "task",
    kind: "browser",
    operation: "observe",
    target: "fixture:tab",
    status: "observed",
  } satisfies Parameters<typeof previews.observe>[0]
  for (let index = 0; index < 100; index++) previews.observe(activity)
  previews.browserTarget("task", target, () => {})
  assert.equal(
    fixture.calls.filter((call) => call.method === "Page.captureScreenshot")
      .length,
    0,
    "Hidden previews do not capture"
  )
  assert.equal(previews.read("other", true), null)
  previews.read("task", true)
  for (
    let attempt = 0;
    attempt < 100 && !previews.read("task", true)?.frame;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(previews.read("task", true)?.frame)
  assert.equal(
    fixture.calls.filter((call) => call.method === "Page.captureScreenshot")
      .length,
    1,
    "Polling while a capture runs does not duplicate it"
  )
  await new Promise((resolve) => setTimeout(resolve, 260))
  assert.equal(events, 1, "Activity bursts publish one narrow event")
  previews.read("task", true, "overlay")
  previews.read("task", false, "panel")
  await new Promise((resolve) => setTimeout(resolve, 400))
  previews.read("task", true, "overlay")
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(
    fixture.calls.filter((call) => call.method === "Page.captureScreenshot")
      .length,
    2,
    "Closing the inspector must not stop the visible chat overlay"
  )
  previews.read("task", false, "overlay")
  previews.observe({
    ...activity,
    kind: "computer",
    target: "different-window",
  })
  assert.equal(
    previews.read("task", false)?.frame,
    null,
    "Target change clears the old image"
  )
  let authorized = true
  previews.computerTarget("task", { pid: 42, windowId: 70 }, () => {
    if (!authorized) throw new Error("Binding closed")
  })
  assert.deepEqual(previews.nativeWindow("task"), { pid: 42, windowId: 70 })
  assert.equal(
    previews.nativeWindow("other"),
    null,
    "Native sources are task scoped"
  )
  authorized = false
  assert.throws(() => previews.nativeWindow("task"), /Binding closed/)
  for (let index = 0; index < 65; index++)
    previews.observe({ ...activity, conversationId: `task-${index}` })
  assert.equal(previews.read("task", false), null, "Retention is bounded")
  console.log(
    "Control previews: hidden capture suppression, one in-flight frame, task isolation, event coalescing, target invalidation and bounded retention passed"
  )
} finally {
  previews.close()
  browser.close()
  await fixture.close()
}
