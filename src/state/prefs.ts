import { createHook, createStore } from "@/state/store"

/**
 * Durable UI preferences. Written through a microtask-batched save so that
 * dragging a panel divider does not hit localStorage on every frame.
 */

export type Theme = "dark" | "light" | "system"
export type InspectorTab = "changes" | "context" | "history"

/** How the session rail is scoped and grouped, mirroring ORCA's sidebar model. */
export type RailScope = "workspace" | "all"
export type RailGroupBy = "none" | "date" | "project"
export type RailSortBy = "recent" | "name" | "size"
export type RailDensity = "comfortable" | "compact"

export interface Prefs {
  theme: Theme
  railOpen: boolean
  inspectorOpen: boolean
  inspectorTab: InspectorTab
  railWidth: number
  inspectorWidth: number
  /** `provider/id` keys, most recent first. */
  favoriteModels: string[]
  recentModels: string[]
  showThinking: boolean
  denseTools: boolean
  railScope: RailScope
  railGroupBy: RailGroupBy
  railSortBy: RailSortBy
  railDensity: RailDensity
  collapsedGroups: string[]
  collapsedDirs: string[]
  glass: boolean
  autoOpenDiff: boolean
  /** Overrides the host's default commit-drafting prompt. */
  commitPrompt?: string
}

const KEY = "pi.prefs.v1"

const defaults: Prefs = {
  theme: "dark",
  railOpen: true,
  inspectorOpen: true,
  inspectorTab: "changes",
  railWidth: 264,
  inspectorWidth: 400,
  favoriteModels: [],
  recentModels: [],
  showThinking: true,
  denseTools: false,
  railScope: "workspace",
  railGroupBy: "date",
  railSortBy: "recent",
  railDensity: "comfortable",
  collapsedGroups: [],
  collapsedDirs: [],
  glass: true,
  autoOpenDiff: true,
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaults
    return { ...defaults, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return defaults
  }
}

export const prefsStore = createStore<Prefs>(load())
export const usePrefs = createHook(prefsStore)

let queued = false
prefsStore.subscribe(() => {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    try {
      localStorage.setItem(KEY, JSON.stringify(prefsStore.get()))
    } catch {
      // A full or disabled store is not worth interrupting the session for.
    }
  })
})

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  prefsStore.set({ [key]: value } as Pick<Prefs, K>)
}

export function togglePref(
  key: "railOpen" | "inspectorOpen" | "showThinking" | "denseTools" | "glass" | "autoOpenDiff"
) {
  prefsStore.set({ [key]: !prefsStore.get()[key] } as Pick<Prefs, typeof key>)
}

export function toggleGroupCollapsed(key: string) {
  const current = prefsStore.get().collapsedGroups
  prefsStore.set({
    collapsedGroups: current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key],
  })
}

export function modelKey(provider: string, id: string) {
  return `${provider}/${id}`
}

export function toggleFavoriteModel(key: string) {
  const current = prefsStore.get().favoriteModels
  prefsStore.set({
    favoriteModels: current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [key, ...current],
  })
}

export function noteModelUse(key: string) {
  const current = prefsStore.get().recentModels.filter((entry) => entry !== key)
  prefsStore.set({ recentModels: [key, ...current].slice(0, 8) })
}

/** Apply the resolved theme class to <html>. Returns a disposer. */
export function bindTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: light)")
  const paint = () => {
    const { theme, glass } = prefsStore.get()
    const light = theme === "light" || (theme === "system" && media.matches)
    document.documentElement.classList.toggle("light", light)
    document.documentElement.style.colorScheme = light ? "light" : "dark"
    // An attribute rather than a class so the depth rules can be written as
    // one scoped block instead of being sprinkled through components.
    document.documentElement.dataset.glass = glass ? "on" : "off"
  }
  paint()
  const off = prefsStore.subscribe(paint)
  media.addEventListener("change", paint)
  return () => {
    off()
    media.removeEventListener("change", paint)
  }
}
