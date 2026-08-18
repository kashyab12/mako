import { createHook, createStore } from "@/state/store"
import { getPi, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import type { Thread, ThreadEntry, ThreadRef, ThreadRunState } from "@/lib/types"

/**
 * Every coding agent's sessions on this machine — not just this app's.
 *
 * The host watches the native stores of every harness it knows (Pi, Codex,
 * Claude Code, Cursor, Grok) and pushes the merged catalog here. Nothing in
 * this store polls: a session grown by a terminal on the other monitor
 * arrives as an event, the same way a streaming token does.
 */

interface ThreadsState {
  threads: ThreadRef[]
  loaded: boolean
  /** The foreign thread open in the viewer overlay, if any. */
  viewing: Thread | null
  viewingBusy: boolean
  continuing: string | null
  /** Harnesses whose CLI can be driven headlessly from here. */
  resumable: string[]
  /** Harnesses a conversation can be continued on, "pi" first. */
  targets: string[]
  /** Harnesses that can be driven interactively (ACP). */
  acpable: string[]
  /** The native run for the viewed thread, if one was started. */
  run: ThreadRunState | null
  /** Every live native run, by thread path — the rail's working dots. */
  running: Record<string, boolean>
  /** A translation in flight: one conversation becoming another harness's. */
  converting: { from: string; to: string; title?: string; done: boolean } | null
}

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  viewingBusy: false,
  continuing: null,
  resumable: [],
  targets: [],
  acpable: [],
  run: null,
  running: {},
  converting: null,
})
export const useThreads = createHook(threadsStore)

export function applyThreads(threads: ThreadRef[]) {
  threadsStore.set({ threads, loaded: true })
}

/** A native run started, finished, or failed, on any thread. */
export function applyThreadRun(run: ThreadRunState) {
  const { viewing, running } = threadsStore.get()
  const next = { ...running }
  if (run.status === "running") next[run.path] = true
  else delete next[run.path]
  threadsStore.set({ running: next })
  if (viewing && viewing.ref.path === run.path) threadsStore.set({ run })
  if (run.status === "failed" && run.error) toast.error(run.error)
}

/** Entries appended — by whatever app is writing — to the viewed thread. */
export function applyThreadEntries(path: string, entries: ThreadEntry[], replace?: boolean) {
  const { viewing } = threadsStore.get()
  if (!viewing || viewing.ref.path !== path) return
  threadsStore.set({
    viewing: { ...viewing, entries: replace ? entries : [...viewing.entries, ...entries] },
  })
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
  const started = Date.now()
  threadsStore.set({ converting: { from, to, title, done: false } })
  try {
    const result = await work()
    const remaining = Math.max(0, 900 - (Date.now() - started))
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
    threadsStore.set({ converting: { from, to, title, done: true } })
    await new Promise((resolve) => setTimeout(resolve, 700))
    return result
  } finally {
    threadsStore.set({ converting: null })
  }
}

export const threads = {
  async load() {
    if (!hasBridge()) return
    const [list, resumable, targets, acpable] = await Promise.all([
      getPi().threads().catch((): ThreadRef[] => []),
      getPi().resumableHarnesses().catch((): string[] => []),
      getPi().continueTargets().catch((): string[] => []),
      getPi().acpHarnesses().catch((): string[] => []),
    ])
    threadsStore.set({ threads: list, loaded: true, resumable, targets, acpable })
  },

  /** Open a foreign session read-only, translated to the canonical shape. */
  async view(ref: ThreadRef) {
    if (!hasBridge()) return
    threadsStore.set({ viewingBusy: true })
    try {
      const thread = await getPi().openThread(ref.path)
      if (!thread) throw new Error("This session could not be read")
      const run = await getPi().threadRun(ref.path).catch(() => null)
      threadsStore.set({ viewing: thread, viewingBusy: false, run })
      // Live from here: the agent writing this session — in whatever app —
      // keeps appending, and those entries belong on screen.
      void getPi().followThread(ref.path, thread.ref.bytes ?? 0)
    } catch (error) {
      threadsStore.set({ viewingBusy: false })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  closeViewer() {
    threadsStore.set({ viewing: null, run: null })
    if (hasBridge()) void getPi().unfollowThread()
  },

  /**
   * Send the next message through the harness that owns this session. The
   * reply streams back through the file tail — the same path a terminal run
   * takes — so nothing here waits on the process.
   */
  async reply(ref: ThreadRef, prompt: string) {
    if (!hasBridge()) return
    try {
      const run = await getPi().resumeThread(ref.path, prompt)
      // Through the same reducer the host's events use, so the rail's
      // working dot lights immediately rather than on the first event.
      applyThreadRun(run)
      threadsStore.set({ run })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async abortReply(ref: ThreadRef) {
    if (!hasBridge()) return
    await getPi().abortThreadRun(ref.path).catch(() => {})
  },

  /**
   * Continue this conversation on a different harness: the transcript
   * becomes the first prompt of a fresh session there. "pi" opens a tab in
   * this app; anything else runs headlessly and surfaces in the rail when
   * its session store appears — which the watcher notices, not this code.
   */
  async continueWith(ref: ThreadRef, harness: string, label: string) {
    if (harness === "pi") return this.continueHere(ref)
    if (!hasBridge()) return false
    try {
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getPi().continueThreadWith(ref.path, harness)
      )
      if (result.kind === "emitted") {
        // The conversation now exists natively in the target's store. Open
        // it in the viewer — instantly replyable, nothing spent yet.
        const thread = await getPi().openThread(result.path)
        if (thread) {
          threadsStore.set({ viewing: thread, run: null })
          void getPi().followThread(result.path, thread.ref.bytes ?? 0)
          toast(`Now a native ${label} session`, {
            description: "Same conversation, new harness. Reply below to set it working.",
          })
          return true
        }
      }
      threadsStore.set({ viewing: null, run: null })
      toast(`${label} picked up the conversation`, {
        description: `Working in ${ref.cwd ?? "its workspace"} — it will appear under Agents.`,
      })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /**
   * Continue a foreign conversation here: a new tab in its working
   * directory, seeded with the transcript. The tab opens on success; the
   * session store's tab machinery takes it from there.
   */
  async continueHere(ref: ThreadRef, instruction?: string) {
    if (!hasBridge()) return false
    threadsStore.set({ continuing: ref.path })
    try {
      void instruction
      await withConversion(ref.harness, "pi", ref.title, () => getPi().continueThread(ref.path))
      threadsStore.set({ continuing: null, viewing: null })
      return true
    } catch (error) {
      threadsStore.set({ continuing: null })
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },
}
