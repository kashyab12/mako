import { createHook, createStore } from "@/state/store"
import { getPi, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import type { Thread, ThreadRef } from "@/lib/types"

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
}

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  viewingBusy: false,
  continuing: null,
})
export const useThreads = createHook(threadsStore)

export function applyThreads(threads: ThreadRef[]) {
  threadsStore.set({ threads, loaded: true })
}

export const threads = {
  async load() {
    if (!hasBridge()) return
    const list = await getPi().threads().catch((): ThreadRef[] => [])
    threadsStore.set({ threads: list, loaded: true })
  },

  /** Open a foreign session read-only, translated to the canonical shape. */
  async view(ref: ThreadRef) {
    if (!hasBridge()) return
    threadsStore.set({ viewingBusy: true })
    try {
      const thread = await getPi().openThread(ref.path)
      if (!thread) throw new Error("This session could not be read")
      threadsStore.set({ viewing: thread, viewingBusy: false })
    } catch (error) {
      threadsStore.set({ viewingBusy: false })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  closeViewer() {
    threadsStore.set({ viewing: null })
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
      await getPi().continueThread(ref.path, instruction)
      threadsStore.set({ continuing: null, viewing: null })
      return true
    } catch (error) {
      threadsStore.set({ continuing: null })
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },
}
