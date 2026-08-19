import { createHook, createStore } from "@/state/store"
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
    if (!hasBridge()) return
    updatesStore.set({ status: "checking" })
    const state = await getMako().checkUpdates().catch(() => null)
    if (state) updatesStore.set(state)
  },

  install() {
    if (!hasBridge()) return
    void getMako().installUpdate()
  },
}
