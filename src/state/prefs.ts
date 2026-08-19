import { createHook, createStore } from "@/state/store"

/**
 * Durable UI preferences. Written through a microtask-batched save so that
 * dragging a panel divider does not hit localStorage on every frame.
 */

export type Theme = "dark" | "light" | "system"
export type InspectorTab = "changes" | "context" | "history"

/** What the left rail is showing: your conversations, or the project. */
export type RailMode = "threads" | "agents" | "files"

/** How the session rail is scoped and grouped, mirroring ORCA's sidebar model. */
export type RailScope = "workspace" | "all"
export type RailGroupBy = "none" | "date" | "project"
export type RailSortBy = "recent" | "created" | "name" | "size"
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
  railMode: RailMode
  railScope: RailScope
  railGroupBy: RailGroupBy
  railSortBy: RailSortBy
  railDensity: RailDensity
  collapsedGroups: string[]
  collapsedDirs: string[]
  /** Folders open in the project tree. Keys are folded paths, not path prefixes. */
  openDirs: string[]
  glass: boolean
  autoOpenDiff: boolean
  /** The dev-server preview, beside the conversation. */
  previewOpen: boolean
  previewWidth: number
  /** The getting-started list is finished or dismissed, and will not return. */
  onboarded: boolean
  /** Checklist steps that have been true at least once. Done is done. */
  onboardedSteps: string[]
  /** Threads kept at the top of both rails, by session path. */
  pinnedThreads: string[]
  /** Harnesses shown in the Agents rail. Empty means all of them. */
  agentHarnessFilter: string[]
  /** The composer's chosen agent, kept across launches. */
  composerHarness?: string
  /** Per-harness model/effort/fast choices — Mako's own memory of them. */
  composerTuning: Record<string, { model?: string; effort?: string; fast?: boolean }>
  /**
   * How a conversation moves to another harness: "native" emits it into the
   * target's own store (a real resumable session); "transcript" writes the
   * full conversation to a file — newest turn first — and opens a fresh
   * session told to read it end to end before continuing.
   */
  conversionMode: "native" | "transcript"
  /** Your names for threads, by path — native stores don't take renames. */
  titleOverrides: Record<string, string>
  /** Each harness's own defaults as last read from its config — never invented. */
  harnessDefaults: Record<string, { model?: string; effort?: string }>
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
  railMode: "threads",
  railScope: "all",
  railGroupBy: "date",
  railSortBy: "recent",
  railDensity: "comfortable",
  collapsedGroups: [],
  collapsedDirs: [],
  openDirs: [],
  glass: true,
  autoOpenDiff: true,
  previewOpen: false,
  previewWidth: 460,
  onboarded: false,
  onboardedSteps: [],
  pinnedThreads: [],
  agentHarnessFilter: [],
  composerTuning: {},
  harnessDefaults: {},
  titleOverrides: {},
  conversionMode: "native",
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaults
    const stored = JSON.parse(raw) as Partial<Prefs> & { railScopeMigrated?: boolean }
    // The rail redesigned around showing every folder; a "workspace" scope
    // persisted under the old design would silently narrow it. One flip.
    if (!stored.railScopeMigrated) {
      stored.railScope = "all"
      stored.railScopeMigrated = true
    }
    return { ...defaults, ...stored }
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

/**
 * Every preference that is a switch, derived rather than listed.
 *
 * The list used to be written out by hand, so adding a boolean preference and
 * then trying to toggle it was a type error in an unrelated file — which is
 * exactly the kind of friction that ends with someone reaching past the helper.
 */
// `-?` matters: an optional preference makes its mapped value `K | undefined`,
// and `undefined` is not a key.
type BooleanPref = { [K in keyof Prefs]-?: Prefs[K] extends boolean ? K : never }[keyof Prefs]

/** Pin or unpin a thread by its session path, newest pin first. */
export function togglePinned(path: string) {
  const current = prefsStore.get().pinnedThreads
  setPref(
    "pinnedThreads",
    current.includes(path) ? current.filter((entry) => entry !== path) : [path, ...current]
  )
}

export function togglePref(key: BooleanPref) {
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
