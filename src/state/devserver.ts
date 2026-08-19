import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import type { DevServerState, ListeningPort } from "@/lib/types"

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
  /** Everything listening on this machine, so any of it can be previewed. */
  ports: ListeningPort[]
  /** Bumped to make the preview reload without recreating the view. */
  reloads: number
}

export const devStore = createStore<Store>({
  status: "idle",
  lines: [],
  scripts: [],
  ports: [],
  reloads: 0,
})
export const useDev = createHook(devStore)

export function applyDevServer(next: DevServerState) {
  devStore.set(next)
}

export const dev = {
  async load() {
    if (!hasBridge()) return
    const [state, scripts] = await Promise.all([
      getMako().devState().catch(() => null),
      getMako().devScripts().catch(() => []),
    ])
    if (state) devStore.set(state)
    devStore.set({ scripts })
    void dev.scan()
  },

  /**
   * What is listening right now.
   *
   * Read on demand rather than watched. Ports change when a server starts or
   * stops, which is a thing you do, not a thing that happens to you — so the
   * moments worth re-reading are exactly the moments the pane is opened or
   * the button is pressed.
   */
  async scan() {
    if (!hasBridge()) return
    const ports = await getMako().ports().catch(() => [])
    devStore.set({ ports })
  },

  async start(script: string) {
    if (!hasBridge()) return
    devStore.set({ status: "starting", script, url: undefined, lines: [] })
    const state = await getMako().devStart(script).catch(() => null)
    if (state) devStore.set(state)
  },

  async stop() {
    if (!hasBridge()) return
    const state = await getMako().devStop().catch(() => null)
    if (state) devStore.set(state)
  },

  async attach(url: string) {
    if (!hasBridge()) return
    const state = await getMako().devAttach(url).catch(() => null)
    if (state) devStore.set(state)
  },

  reload() {
    devStore.set({ reloads: devStore.get().reloads + 1 })
  },
}
