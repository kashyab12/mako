import { createHook, createStore } from "@/state/store"
import { getPi, hasBridge } from "@/lib/bridge"
import type { DevServerState } from "@/lib/types"

/**
 * The dev server, mirrored from the host.
 *
 * Its own store for the same reason updates have one: it is window-wide, it
 * survives tab switches, and a log line arriving twice a second has no
 * business waking anything that reads session state.
 */

interface Store extends DevServerState {
  /** npm scripts this project has that look like servers. */
  scripts: string[]
  /** Bumped to make the preview reload without recreating the view. */
  reloads: number
}

export const devStore = createStore<Store>({ status: "idle", lines: [], scripts: [], reloads: 0 })
export const useDev = createHook(devStore)

export function applyDevServer(next: DevServerState) {
  devStore.set(next)
}

export const dev = {
  async load() {
    if (!hasBridge()) return
    const [state, scripts] = await Promise.all([
      getPi().devState().catch(() => null),
      getPi().devScripts().catch(() => []),
    ])
    if (state) devStore.set(state)
    devStore.set({ scripts })
  },

  async start(script: string) {
    if (!hasBridge()) return
    devStore.set({ status: "starting", script, url: undefined, lines: [] })
    const state = await getPi().devStart(script).catch(() => null)
    if (state) devStore.set(state)
  },

  async stop() {
    if (!hasBridge()) return
    const state = await getPi().devStop().catch(() => null)
    if (state) devStore.set(state)
  },

  async attach(url: string) {
    if (!hasBridge()) return
    const state = await getPi().devAttach(url).catch(() => null)
    if (state) devStore.set(state)
  },

  reload() {
    devStore.set({ reloads: devStore.get().reloads + 1 })
  },
}
