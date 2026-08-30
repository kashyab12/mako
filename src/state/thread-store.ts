import { prefsStore } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import type { ThreadsState } from "@/state/thread-state"

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  opening: null,
  viewingBusy: false,
  resumable: [],
  targets: [],
  acpable: [],
  run: null,
  working: {},
  attention: {},
  observed: {},
  converting: null,
  composerHarness: prefsStore.get().composerHarness ?? "claude",
  composerTuning: prefsStore.get().composerTuning,
  queuedReplies: {},
})

export const useThreads = createHook(threadsStore)
