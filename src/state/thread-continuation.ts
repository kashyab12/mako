import { getMako, hasBridge } from "@/lib/bridge"
import type { ThreadRef } from "@/lib/types"
import { prefsStore } from "@/state/prefs"
import {
  appendOptimisticReply,
  queueReply,
  removeOptimisticReply,
} from "@/state/thread-queue"
import { applyThreadRun, threadStatus } from "@/state/thread-status"
import { canResumeInteractively } from "@/state/thread-tuning"
import { leaveViewerForLive, viewedThread } from "@/state/thread-viewing"
import { threadsStore } from "@/state/thread-store"
import { toast } from "sonner"

const HARNESS_NAMES = new Map([
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["devin", "Devin"],
  ["opencode", "OpenCode"],
])

function harnessLabelOf(harness: string): string {
  return HARNESS_NAMES.get(harness) ?? harness
}

/** A just-started conversation waiting for its session file to appear. */
let pendingOpen: { harness: string; cwd: string; since: number } | null = null

/**
 * A conversation started from the composer opens itself the moment the
 * harness writes its session file — the watcher sees it, the list updates,
 * and this picks it out by harness, folder, and birth time.
 */
export function takePendingThread(
  list: ThreadRef[],
  knownPaths: ReadonlySet<string>
): ThreadRef | null {
  if (!pendingOpen) return null
  const target = pendingOpen
  const candidate = list.find(
    (ref) =>
      !knownPaths.has(ref.path) &&
      ref.harness === target.harness &&
      ref.cwd === target.cwd &&
      (!ref.startedAt || Date.parse(ref.startedAt) >= target.since - 60_000)
  )
  if (candidate) {
    pendingOpen = null
    return candidate
  }
  if (Date.now() - target.since > 5 * 60_000) pendingOpen = null
  return null
}

/**
 * Show the translation while it happens, and for long enough to be seen.
 *
 * The emitters are fast — usually under a second — which is exactly why the
 * moment needs a floor: a conversation changing harnesses is the headline
 * act of this app, and a flicker would read as nothing having happened.
 */
export async function withConversion<T>(
  from: string,
  to: string,
  title: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  threadsStore.set({ converting: { from, to, title, done: false } })
  try {
    const result = await work()
    threadsStore.set({ converting: { from, to, title, done: true } })
    setTimeout(() => {
      if (threadsStore.get().converting?.done)
        threadsStore.set({ converting: null })
    }, 300)
    return result
  } catch (error) {
    threadsStore.set({ converting: null })
    throw error
  }
}

export const threadContinuationActions = {
  /**
   * Send the next message through the harness that owns this session. The
   * reply streams back through the file tail — the same path a terminal run
   * takes — so nothing here waits on the process.
   */
  async reply(ref: ThreadRef, prompt: string): Promise<boolean> {
    if (!hasBridge()) return false
    const status = threadStatus(ref)
    if (status.kind === "external-open" || status.kind === "external-active") {
      return threadContinuationActions.moveAndSend(ref, ref.harness, prompt)
    }
    if (status.kind === "observed") {
      toast("Live activity detected", {
        description:
          "Wait for this turn to settle, or choose another agent to continue in a new thread.",
      })
      return false
    }
    if (threadsStore.get().working[ref.path]) {
      queueReply(ref, prompt)
      return true
    }
    // Paint the message NOW. Provider startup, session translation, and the
    // native tail all happen after the send is already visible.
    const echoed = appendOptimisticReply(ref, prompt)
    if (
      canResumeInteractively(ref.harness) &&
      threadsStore.get().acpable.includes(ref.harness)
    ) {
      const resumed = await (
        await import("@/state/acp")
      ).acp.resumeAndSend(ref, prompt)
      if (resumed) return true
    }
    try {
      // The composer's tuning rides on the reply: pick a different model or
      // effort while a conversation is open and the next turn uses it.
      const tuning = threadsStore.get().composerTuning[ref.harness]
      const run = await getMako().resumeThread(ref.path, prompt, tuning)
      // Through the same reducer the host's events use, so the rail's
      // working dot lights immediately rather than on the first event.
      applyThreadRun(run)
      threadsStore.set({ run })
      return true
    } catch (error) {
      // The send failed: take the echo back out so the transcript stays true.
      if (echoed) removeOptimisticReply(ref, prompt)
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /** Move and send through the selected provider, using transcript replay by default. */
  async moveAndSend(
    ref: ThreadRef,
    harness: string,
    prompt: string
  ): Promise<boolean> {
    if (!hasBridge()) return false
    threadsStore.set({ composerHarness: harness })
    const echoed = appendOptimisticReply(ref, prompt)
    try {
      const mode = prefsStore.get().conversionMode
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getMako().continueThreadWith(ref.path, harness, prompt, mode)
      )
      if (result.kind === "emitted") {
        const thread = await getMako().openThread(result.path)
        if (thread) {
          threadsStore.set({ viewing: viewedThread(thread), run: null })
          void getMako().followThread(result.path, thread.ref.bytes ?? 0)
          return threadContinuationActions.reply(thread.ref, prompt)
        }
      } else if (result.kind === "prepared") {
        const supportsLive = threadsStore.get().acpable.includes(harness)
        const ok = supportsLive
          ? await (
              await import("@/state/acp")
            ).acp.startFresh(
              harness,
              result.cwd,
              result.prompt,
              [],
              prompt,
              ref.path
            )
          : await threadContinuationActions.startNew(harness, result.prompt)
        if (ok && supportsLive && echoed) removeOptimisticReply(ref, prompt)
        if (!ok && echoed) removeOptimisticReply(ref, prompt)
        return ok
      }
      if (echoed) removeOptimisticReply(ref, prompt)
      return false
    } catch (error) {
      if (echoed) removeOptimisticReply(ref, prompt)
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /** Fork after one completed answer, using the transcript bundle as context. */
  async forkAt(
    ref: ThreadRef,
    upto: number,
    harness: string
  ): Promise<boolean> {
    if (!hasBridge()) return false
    try {
      const prepared = await withConversion(
        ref.harness,
        harness,
        ref.title,
        () => getMako().forkThread(ref.path, upto, harness)
      )
      threadsStore.set({ composerHarness: harness })
      const supportsLive = threadsStore.get().acpable.includes(harness)
      const ok = supportsLive
        ? await (
            await import("@/state/acp")
          ).acp.startFresh(harness, prepared.cwd, prepared.prompt, [], "")
        : await threadContinuationActions.startNew(harness, prepared.prompt)
      if (ok) {
        if (supportsLive) leaveViewerForLive(harness)
        toast("Forked", {
          description: `A new ${harnessLabelOf(harness)} conversation starts after that answer.`,
        })
      }
      return ok
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async abortReply(ref: ThreadRef) {
    if (!hasBridge()) return false
    try {
      await getMako().abortThreadRun(ref.path)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /**
   * Interrupt and send: stop the current turn, and the message goes out on
   * the release. One gesture — the queue machinery does the sequencing.
   */
  async interruptAndSend(ref: ThreadRef, prompt: string): Promise<boolean> {
    if (!hasBridge()) return false
    const ok = await threadContinuationActions.reply(ref, prompt)
    if (ok && threadsStore.get().working[ref.path]) {
      try {
        await getMako().abortThreadRun(ref.path)
      } catch {
        toast.error("The turn could not be stopped; your message remains queued")
      }
    }
    return ok
  },

  /**
   * A new conversation on another harness, straight from the composer. The
   * CLI runs headlessly in the active workspace; when its session file
   * appears, the conversation opens here and the reply bar carries the next
   * turn. Same chat column, different agent — which is the whole idea.
   */
  async startNew(harness: string, prompt: string) {
    if (!hasBridge()) return false
    try {
      const options = threadsStore.get().composerTuning[harness] ?? {}
      const { cwd } = await getMako().startHarness(harness, prompt, options)
      pendingOpen = { harness, cwd, since: Date.now() }
      toast(`${harnessLabelOf(harness)} is on it`, {
        description:
          "The conversation opens here as soon as its first write lands.",
      })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async continueWith(ref: ThreadRef, harness: string, label: string) {
    if (!hasBridge()) return false
    try {
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getMako().continueThreadWith(
          ref.path,
          harness,
          undefined,
          prefsStore.get().conversionMode
        )
      )
      if (result.kind === "emitted") {
        const thread = await getMako().openThread(result.path)
        if (!thread) return false
        threadsStore.set({ viewing: viewedThread(thread), run: null })
        void getMako().followThread(result.path, thread.ref.bytes ?? 0)
        toast(`${label} session imported`, {
          description: "Reply below when you are ready to continue.",
        })
        return true
      }
      threadsStore.set({ composerHarness: harness })
      const supportsLive = threadsStore.get().acpable.includes(harness)
      const ok = supportsLive
        ? await (
            await import("@/state/acp")
          ).acp.startFresh(harness, result.cwd, result.prompt, [], "")
        : await threadContinuationActions.startNew(harness, result.prompt)
      if (ok) {
        if (supportsLive) leaveViewerForLive(harness)
        toast(`${label} picked up the conversation`)
      }
      return ok
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },
}
