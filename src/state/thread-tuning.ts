import { setPref } from "@/state/prefs"
import { threadsStore } from "@/state/thread-store"

export function canResumeInteractively(harness: string): boolean {
  return threadsStore.get().interactiveResume.includes(harness)
}

/** The composer's agent, remembered across launches. */
export function setComposerHarness(harness: string) {
  threadsStore.set({ composerHarness: harness })
  setPref("composerHarness", harness)
}
