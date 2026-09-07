import assert from "node:assert/strict"
import { BrowserToolsRuntime } from "../electron/browser-tools-runtime.js"

const calls: string[] = []
const first = new BrowserToolsRuntime(async (command) => {
  calls.push(command.action)
  return []
})
const second = new BrowserToolsRuntime(async () => [])
try {
  await first.run(
    "state.value='first'; return state.value",
    new AbortController().signal
  )
  const separate = await second.run(
    "return state.value ?? 'empty'",
    new AbortController().signal
  )
  assert.match(JSON.stringify(separate), /empty/)
  const abort = new AbortController()
  const busy = first.run("while(true) {}", abort.signal)
  const failed = assert.rejects(busy, /cancelled/i)
  const queuedAbort = new AbortController()
  const queued = first.run("await browser.status()", queuedAbort.signal)
  const queuedFailed = assert.rejects(queued)
  queuedAbort.abort()
  setTimeout(() => abort.abort(), 100)
  await Promise.all([failed, queuedFailed])
  assert.deepEqual(calls, [])
  const reset = await first.run(
    "return state.value ?? 'reset'",
    new AbortController().signal
  )
  assert.match(JSON.stringify(reset), /reset/)
  const next = await first.run(
    "await browser.status(); return 'next'",
    new AbortController().signal
  )
  assert.match(JSON.stringify(next), /next/)
  assert.deepEqual(calls, ["status"])
  const late = new BrowserToolsRuntime(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return []
  })
  try {
    await assert.rejects(
      late.run(
        "browser.status(); return 'too early'",
        new AbortController().signal
      ),
      /unawaited/
    )
    const clean = await late.run(
      "return state.value ?? 'clean'",
      new AbortController().signal
    )
    assert.match(JSON.stringify(clean), /clean/)
    await late.run(
      "setTimeout(() => { try { browser.status() } catch {} }, 50); return 'done'",
      new AbortController().signal
    )
    const isolated = await late.run(
      "await new Promise(resolve => setTimeout(resolve, 100)); return 'isolated'",
      new AbortController().signal
    )
    assert.deepEqual(isolated, [{ type: "text", text: '"isolated"' }])
  } finally {
    await late.close()
  }
  console.log(
    "Browser scripts: isolated persistent state, CPU-bound cancellation, canceled queued work never dispatches, and recovery after worker reset"
  )
} finally {
  await first.close()
  await second.close()
}
