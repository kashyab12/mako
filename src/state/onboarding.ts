import { prefsStore, setPref } from "@/state/prefs"
import { store } from "@/state/session"
import { viewerStore } from "@/state/viewer"

/**
 * Latches getting-started steps the moment they become true — wherever the
 * user is. The checklist component only exists on an empty transcript, so
 * deriving completion there meant a step done mid-conversation was never
 * recorded, and one done by switching rail modes *un-did* itself on the way
 * back. Done is done; this watches the stores, not the component tree.
 */
export function watchOnboarding(): void {
  const latch = (id: string) => {
    const current = prefsStore.get().onboardedSteps
    if (!current.includes(id)) setPref("onboardedSteps", [...current, id])
  }

  const check = () => {
    if (prefsStore.get().onboarded) return
    const session = store.get()
    if (session.messages.length > 0) latch("ask")
    const cwd = session.meta?.cwd
    if (cwd && cwd.split("/").filter(Boolean).length > 2) latch("workspace")
    if (viewerStore.get().path) latch("files")
    const prefs = prefsStore.get()
    if (prefs.railMode === "files" || prefs.openDirs.length > 0) latch("files")
    if (prefs.autoOpenDiff) latch("review")
  }

  store.subscribe(check)
  viewerStore.subscribe(check)
  prefsStore.subscribe(check)
  check()
}
