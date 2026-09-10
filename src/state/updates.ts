import { createHook, createStore } from "@/state/store"
import { application } from "@/state/application"
import { getMako, hasBridge } from "@/lib/bridge"
import type { UpdateState } from "@/lib/types"

/**
 * The update state, mirrored from the host.
 *
 * Its own store rather than a field on the session store, because it has
 * nothing to do with a conversation: it survives tab switches, it is
 * window-wide, and putting it in `session` would wake every selector that
 * reads `meta` each time a download ticks a percent.
 */
export const updatesStore = createStore<UpdateState>({ status: "idle", version: "" })
export const useUpdates = createHook(updatesStore)

export function applyUpdate(next: UpdateState) {
  updatesStore.set(next)
}

export const updates = {
  async load() {
    if (!hasBridge()) return
    const state = await getMako().updateState().catch(() => null)
    if (state) updatesStore.set(state)
  },

  async check() {
    if (!hasBridge() || updatesStore.get().status === "checking" || updatesStore.get().status === "downloading") return
    updatesStore.set({ status: "checking", error: undefined })
    try { updatesStore.set(await getMako().checkUpdates()) }
    catch (error) { updatesStore.set({ status: "error", error: error instanceof Error ? error.message : "Could not check for updates. Try again." }) }
  },

  install() {
    if (!hasBridge()) return
    void application.request("install")
  },

  /** Quit and come back on the current build. Conversations reopen from their journals. */
  relaunch() {
    if (!hasBridge()) return
    void application.request("restart")
  },
}
