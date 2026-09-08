import { getMako, hasBridge } from "@/lib/bridge"
import type { HarnessProfile } from "@/lib/types"
import { createHook, createStore } from "@/state/store"

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
  contexts: Record<string, HarnessProfile>
  availability: Record<string, boolean> | null
  daemon: DaemonInfo | null
  daemonLogin: boolean | null
}

export const providerStore = createStore<ProviderState>({
  profiles: {},
  contexts: {},
  availability: null,
  daemon: null,
  daemonLogin: null,
})

export const useProviders = createHook(providerStore)

let loaded = false
let loading: Promise<void> | null = null

export function providerProfileKey(provider: string, cwd: string): string {
  return JSON.stringify([provider, cwd])
}

const requests = new Map<string, Promise<void>>()
const loadedAt = new Map<string, number>()
const generations = new Map<string, number>()
const scopes = new Map<string, { provider: string; cwd: string }>()

function admit(profile: HarnessProfile, cwd: string): void {
  providerStore.set({
    profiles: { ...providerStore.get().profiles, [profile.id]: profile },
    contexts: {
      ...providerStore.get().contexts,
      [providerProfileKey(profile.id, cwd)]: profile,
    },
  })
}

export const providers = {
  async refreshAccount(provider: string): Promise<void> {
    generations.set(provider, (generations.get(provider) ?? 0) + 1)
    const contexts = { ...providerStore.get().contexts }
    const workspaces = new Set<string>()
    for (const [key, scope] of scopes) {
      if (scope.provider !== provider) continue
      workspaces.add(scope.cwd)
      delete contexts[key]
      loadedAt.delete(key)
      requests.delete(key)
    }
    const profiles = { ...providerStore.get().profiles }
    delete profiles[provider]
    providerStore.set({ profiles, contexts })
    if (!workspaces.size) workspaces.add("")
    await Promise.all(
      [...workspaces].map((cwd) => providers.load(provider, true, cwd))
    )
  },

  async loadAll(force = false): Promise<void> {
    if (!hasBridge() || (loaded && !force)) return
    if (loading) return loading
    const accountGenerations = new Map(generations)
    loading = getMako()
      .harnessProfiles(force)
      .then((profiles) => {
        const next = { ...providerStore.get().profiles }
        for (const profile of profiles) {
          if (
            (generations.get(profile.id) ?? 0) ===
            (accountGenerations.get(profile.id) ?? 0)
          )
            next[profile.id] = profile
        }
        providerStore.set({ profiles: next })
        loaded = true
      })
      .catch(() => undefined)
      .finally(() => {
        loading = null
      })
    return loading
  },

  async load(provider: string, force = false, cwd = ""): Promise<void> {
    if (!hasBridge()) return
    const key = providerProfileKey(provider, cwd)
    scopes.set(key, { provider, cwd })
    const active = requests.get(key)
    if (active) return active
    if (!force && Date.now() - (loadedAt.get(key) ?? 0) < 30_000) return
    const generation = generations.get(provider) ?? 0
    const request = getMako()
      .harnessTuning(provider, cwd || undefined, force)
      .then((profile) => {
        if ((generations.get(provider) ?? 0) !== generation) return
        admit(profile, cwd)
        loadedAt.set(key, Date.now())
      })
      .finally(() => {
        if (requests.get(key) === request) requests.delete(key)
      })
    requests.set(key, request)
    return request
  },

  async loadStatus(): Promise<void> {
    if (!hasBridge()) return
    const [availability, daemon, daemonLogin] = await Promise.all([
      getMako()
        .harnessAvailability()
        .catch(() => ({})),
      getMako()
        .daemonStatus()
        .catch(() => null),
      getMako()
        .daemonLogin()
        .catch(() => null),
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
