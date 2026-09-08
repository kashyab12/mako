import assert from "node:assert/strict"
import { mock } from "node:test"
import type { ControlPreview } from "../electron/shared.js"

const visibility = Object.assign(new EventTarget(), { hidden: false })
const calls: { id: string; watching: boolean }[] = []
const previews = new Map<string, ControlPreview>()
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: visibility,
})
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    mako: {
      controlPreview: async (id: string, watching: boolean) => {
        calls.push({ id, watching })
        const preview = previews.get(id)
        return preview
          ? {
              ...preview,
              window:
                Date.now() - preview.activity.updatedAt >= 5_000
                  ? undefined
                  : preview.window,
            }
          : null
      },
    },
  },
})
const { controlPreviewStore, receiveControlActivity, watchControlPreview } =
  await import("../src/state/control-preview.js")
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 })
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const cleanups: (() => void)[] = []
try {
  for (const id of ["one", "two"]) {
    const activity = {
      conversationId: id,
      kind: "computer",
      operation: "observe",
      target: id,
      status: "observed",
      updatedAt: Date.now(),
    } satisfies ControlPreview["activity"]
    previews.set(id, {
      activity,
      window: { pid: 1, windowId: id === "one" ? 1 : 2 },
      frame: null,
    })
    receiveControlActivity(activity)
    cleanups.push(watchControlPreview(id))
  }
  await flush()
  assert.equal(
    controlPreviewStore.get().previews.one?.activity.conversationId,
    "one"
  )
  assert.equal(
    controlPreviewStore.get().previews.two?.activity.conversationId,
    "two"
  )
  const beforeInspector = calls.length
  const closeInspector = watchControlPreview("one")
  await flush()
  assert.equal(
    calls.length,
    beforeInspector,
    "The inspector and overlay share one polling subscription"
  )
  closeInspector()
  assert.ok(controlPreviewStore.get().previews.one)
  for (let tick = 0; tick < 12; tick++) {
    mock.timers.tick(500)
    await flush()
  }
  const idleCalls = calls.length
  assert.equal(controlPreviewStore.get().previews.one?.window, undefined)
  mock.timers.tick(60_000)
  await flush()
  assert.equal(calls.length, idleCalls, "Idle previews make zero polling calls")
  const preview = previews.get("one")!
  preview.activity = { ...preview.activity, updatedAt: Date.now() }
  receiveControlActivity(preview.activity)
  await flush()
  assert.ok(calls.length > idleCalls, "A new action wakes its preview")
  visibility.hidden = true
  visibility.dispatchEvent(new Event("visibilitychange"))
  await flush()
  const hiddenCalls = calls.length
  mock.timers.tick(10_000)
  await flush()
  assert.equal(
    calls.length,
    hiddenCalls,
    "Hidden documents make zero polling calls"
  )
  console.log(
    "Preview state: independent tasks, consumer cleanup, idle shutdown, event wakeup and zero hidden polling passed"
  )
} finally {
  for (const cleanup of cleanups) cleanup()
  mock.timers.reset()
  for (const [key, descriptor] of [
    ["window", priorWindow],
    ["document", priorDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
}
