import { getMako, hasBridge } from "@/lib/bridge"
import type { HarnessProfile } from "@/lib/types"
import { createHook, createStore } from "@/state/store"
import { initializeComposerTuning } from "@/state/threads"

export interface DaemonInfo {
  pid: number
  startedAt: number
  sessions: number
  rss?: number
  heapUsed?: number
  eventLoopP99Ms?: number
}

interface ProviderState {
  profiles: Record<string, HarnessProfile>
  availability: Record<string, boolean> | null
  daemon: DaemonInfo | null
  daemonLogin: boolean | null
}

const providerStore = createStore<ProviderState>({
  profiles: {},
  availability: null,
  daemon: null,
  daemonLogin: null,
})

export const useProviders = createHook(providerStore)

let loaded = false
let loading: Promise<void> | null = null

function admit(profile: HarnessProfile): void {
  providerStore.set({
    profiles: { ...providerStore.get().profiles, [profile.id]: profile },
  })
  initializeComposerTuning(profile)
}

export const providers = {
  async loadAll(force = false): Promise<void> {
    if (!hasBridge() || (loaded && !force)) return
    if (loading) return loading
    loading = getMako()
      .harnessProfiles(force)
      .then((profiles) => {
        const next = { ...providerStore.get().profiles }
        for (const profile of profiles) next[profile.id] = profile
        providerStore.set({ profiles: next })
        for (const profile of profiles) initializeComposerTuning(profile)
        loaded = true
      })
      .catch(() => undefined)
      .finally(() => {
        loading = null
      })
    return loading
  },

  async load(provider: string, force = false): Promise<void> {
    if (
      !hasBridge() ||
      (!force && providerStore.get().profiles[provider] !== undefined)
    )
      return
    const profile = await getMako().harnessTuning(provider).catch(() => null)
    if (profile) admit(profile)
  },

  async loadStatus(): Promise<void> {
    if (!hasBridge()) return
    const [availability, daemon, daemonLogin] = await Promise.all([
      getMako().harnessAvailability().catch(() => ({})),
      getMako().daemonStatus().catch(() => null),
      getMako().daemonLogin().catch(() => null),
    ])
    providerStore.set({ availability, daemon, daemonLogin })
  },

  async setDaemonLogin(enabled: boolean): Promise<void> {
    const previous = providerStore.get().daemonLogin
    providerStore.set({ daemonLogin: enabled })
    try {
      await getMako().setDaemonLogin(enabled)
    } catch (error) {
      providerStore.set({ daemonLogin: previous })
      throw error
    }
  },
}
