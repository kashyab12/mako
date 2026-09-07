import { prefsStore } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import type { ThreadsState } from "@/state/thread-state"

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  opening: null,

  resumable: [],
  targets: [],
  acpable: [],
  interactiveResume: [],
  run: null,
  working: {},
  attention: {},
  observed: {},
  externalActivity: {},
  converting: null,
  composerHarness: prefsStore.get().composerHarness ?? "claude",
  composerTuning: prefsStore.get().composerTuning,
  nativeRequests: [],
})

export const useThreads = createHook(threadsStore)
