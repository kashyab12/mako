import assert from "node:assert/strict"
import { createMakoBridge, type ThreadPage, type ThreadRef } from "../electron/shared.ts"
import { threadViewingActions } from "../src/state/thread-viewing.ts"
import { threadsStore } from "../src/state/thread-store.ts"
import { draftText, rememberDraft } from "../src/state/drafts.ts"

const pending = new Map<string, ReturnType<typeof Promise.withResolvers<ThreadPage | null>>>()
const follows: string[] = []
const bridge = createMakoBridge({
  invoke: async (channel, ...args) => {
    if (channel === "mako:thread-page") {
      const key = String(args[0])
      const request = Promise.withResolvers<ThreadPage | null>()
      pending.set(key, request)
      return request.promise
    }
    if (channel === "mako:follow-thread") follows.push(String(args[0]))
    return null
  },
  onEvent: () => () => {}, onTerminalEvent: () => () => {}, pathForFile: () => null,
})
Object.assign(globalThis, { window: { mako: bridge } })
const first: ThreadRef = { harness: "claude", nativeId: "one", path: "/one" }
const second: ThreadRef = { harness: "grok", nativeId: "two", path: "/two" }
const waitFor = async (path: string) => {
  for (let i = 0; i < 30 && !pending.has(path); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(pending.has(path), "Page read must start")
}
const firstRead = threadViewingActions.view(first)
await waitFor(first.path)
assert.deepEqual(threadsStore.get().opening, { kind: "loading", ref: first })
assert.equal(threadsStore.get().composerHarness, "claude")
rememberDraft(first.path, "Keep this paragraph while the thread loads")
const secondRead = threadViewingActions.view(second)
await waitFor(second.path)
pending.get(first.path)?.resolve({ ref: first, entries: [], start: 0, total: 0, hasEarlier: false })
await firstRead
assert.equal(threadsStore.get().opening?.ref.path, second.path, "A late first response cannot replace the selected conversation")
pending.get(second.path)?.reject(new Error("Native store is temporarily unavailable"))
await secondRead
assert.deepEqual(threadsStore.get().opening, { kind: "failed", ref: second, error: "Native store is temporarily unavailable" })
assert.equal(threadsStore.get().composerHarness, "grok")
assert.equal(draftText(first.path), "Keep this paragraph while the thread loads")
assert.deepEqual(follows, [], "Neither a superseded nor a failed read starts following")
threadViewingActions.closeViewer()
assert.equal(threadsStore.get().opening, null)
console.log("Thread opening: exact draft/provider ownership, out-of-order results, readable failure state and explicit close verified")
