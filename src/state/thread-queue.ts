import type { ThreadRef } from "@/lib/types"
import type { ViewedUserEntry } from "@/state/thread-state"
import { threadsStore } from "@/state/thread-store"

const releasingReplies = new Set<string>()

export function appendOptimisticReply(ref: ThreadRef, prompt: string): boolean {
  const { viewing } = threadsStore.get()
  if (!viewing || viewing.ref.path !== ref.path) return false
  const echo: ViewedUserEntry = {
    kind: "user",
    at: new Date().toISOString(),
    text: prompt,
    echo: true,
  }
  threadsStore.set({
    viewing: { ...viewing, entries: [...viewing.entries, echo] },
  })
  return true
}

export function queueReply(ref: ThreadRef, prompt: string): void {
  // A busy thread queues instead of dropping: the message paints now (the
  // echo below) and goes out the moment the current run ends.
  const all = { ...threadsStore.get().queuedReplies }
  const queue = all[ref.path] ?? { ref, prompts: [] }
  all[ref.path] = { ref, prompts: [...queue.prompts, prompt] }
  threadsStore.set({ queuedReplies: all })
  appendOptimisticReply(ref, prompt)
}

/**
 * A finished run releases its queue: the next waiting prompt goes out
 * through the same reply path, one at a time, in the order they were
 * typed. Interrupt works the same way — abort stops the run, and the
 * queued message rides the release.
 */
export function releaseQueuedReply(path: string): void {
  const queue = threadsStore.get().queuedReplies[path]
  const prompt = queue?.prompts[0]
  if (!queue || prompt === undefined || releasingReplies.has(path)) return

  releasingReplies.add(path)
  setTimeout(() => {
    void import("@/state/threads")
      .then(({ threads }) => threads.reply(queue.ref, prompt))
      .then((sent) => {
        if (!sent) return
        const current = threadsStore.get().queuedReplies[path]
        if (current?.prompts[0] !== prompt) return
        const rest = current.prompts.slice(1)
        const all = { ...threadsStore.get().queuedReplies }
        if (rest.length > 0) all[path] = { ...current, prompts: rest }
        else delete all[path]
        threadsStore.set({ queuedReplies: all })
      })
      .finally(() => releasingReplies.delete(path))
  }, 50)
}
