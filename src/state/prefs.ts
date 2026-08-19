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

interface PreferenceStringMap {
  [key: string]: string
}

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
  composerTuning: Record<
    string,
    {
      model?: string
      effort?: string
      fast?: boolean
      options?: Record<string, string | boolean>
    }
  >
  /** Providers whose initial settings have already been copied into Mako. */
  providerTuningImported: string[]
  keybindings: PreferenceStringMap
  /**
   * How a conversation moves to another harness. Transcript replay is the
   * loss-aware default; session import is the compatibility path for stores
   * that accept synthesized history.
   */
  conversionMode: "native" | "transcript"
  /** Your names for threads, by path — native stores don't take renames. */
  titleOverrides: PreferenceStringMap
  /** Overrides the host's default commit-drafting prompt. */
  commitPrompt?: string
}

const KEY = "mako.prefs.v1"
const LEGACY_KEY = "pi.prefs.v1"

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
  providerTuningImported: [],
  keybindings: {},
  titleOverrides: {},
  conversionMode: "transcript",
}

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = null | boolean | number | string | JsonObject | JsonValue[]
type StoredValue = JsonValue | undefined

function isJsonObject(value: StoredValue): value is JsonObject {
  return Object(value) === value && !Array.isArray(value)
}

function isJsonArray(value: StoredValue): value is JsonValue[] {
  return Array.isArray(value)
}

function isJsonString(value: StoredValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isJsonNumber(value: StoredValue): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(Number(value))
  )
}

function isJsonBoolean(value: StoredValue): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

function readOptionalString(value: StoredValue): string | undefined {
  return isJsonString(value) ? value : undefined
}

function readComposerHarness(value: StoredValue): string | undefined {
  const harness = readOptionalString(value)
  return harness === "pi" ? "devin" : harness
}

function readNumber(value: StoredValue, fallback: number): number {
  return isJsonNumber(value) ? value : fallback
}

function readBoolean(value: StoredValue, fallback: boolean): boolean {
  return isJsonBoolean(value) ? value : fallback
}

function readChoice<const Choice extends string>(
  value: StoredValue,
  choices: readonly Choice[],
  fallback: Choice
): Choice {
  if (!isJsonString(value)) return fallback
  return choices.find((choice) => choice === value) ?? fallback
}

function readStringList(value: StoredValue, fallback: string[]): string[] {
  if (!isJsonArray(value) || !value.every(isJsonString)) return fallback
  return value
}

function readStringRecord(value: StoredValue): PreferenceStringMap {
  if (!isJsonObject(value)) return {}
  const record: PreferenceStringMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonString(entry)) record[key] = entry
  }
  return record
}

function readTuningOptions(
  value: StoredValue
): Record<string, string | boolean> | undefined {
  if (!isJsonObject(value)) return undefined
  const options: Record<string, string | boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonString(entry) || isJsonBoolean(entry)) options[key] = entry
  }
  return options
}

function readComposerTuning(
  value: StoredValue
): Prefs["composerTuning"] {
  if (!isJsonObject(value)) return {}
  const tuning: Prefs["composerTuning"] = {}
  for (const [harness, entry] of Object.entries(value)) {
    if (!isJsonObject(entry)) continue
    tuning[harness] = {
      model: readOptionalString(entry.model),
      effort: readOptionalString(entry.effort),
      fast: isJsonBoolean(entry.fast) ? entry.fast : undefined,
      options: readTuningOptions(entry.options),
    }
  }
  return tuning
}

function parsePrefs(value: JsonValue): Prefs | null {
  if (!isJsonObject(value)) return null
  const prefs: Prefs = {
    theme: readChoice(value.theme, ["dark", "light", "system"], defaults.theme),
    railOpen: readBoolean(value.railOpen, defaults.railOpen),
    inspectorOpen: readBoolean(value.inspectorOpen, defaults.inspectorOpen),
    inspectorTab: readChoice(
      value.inspectorTab,
      ["changes", "context", "history"],
      defaults.inspectorTab
    ),
    railWidth: readNumber(value.railWidth, defaults.railWidth),
    inspectorWidth: readNumber(value.inspectorWidth, defaults.inspectorWidth),
    favoriteModels: readStringList(value.favoriteModels, defaults.favoriteModels),
    recentModels: readStringList(value.recentModels, defaults.recentModels),
    showThinking: readBoolean(value.showThinking, defaults.showThinking),
    denseTools: readBoolean(value.denseTools, defaults.denseTools),
    railMode: readChoice(
      value.railMode,
      ["threads", "agents", "files"],
      defaults.railMode
    ),
    railScope: readChoice(
      value.railScope,
      ["workspace", "all"],
      defaults.railScope
    ),
    railGroupBy: readChoice(
      value.railGroupBy,
      ["none", "date", "project"],
      defaults.railGroupBy
    ),
    railSortBy: readChoice(
      value.railSortBy,
      ["recent", "created", "name", "size"],
      defaults.railSortBy
    ),
    railDensity: readChoice(
      value.railDensity,
      ["comfortable", "compact"],
      defaults.railDensity
    ),
    collapsedGroups: readStringList(
      value.collapsedGroups,
      defaults.collapsedGroups
    ),
    collapsedDirs: readStringList(value.collapsedDirs, defaults.collapsedDirs),
    openDirs: readStringList(value.openDirs, defaults.openDirs),
    glass: readBoolean(value.glass, defaults.glass),
    autoOpenDiff: readBoolean(value.autoOpenDiff, defaults.autoOpenDiff),
    previewOpen: readBoolean(value.previewOpen, defaults.previewOpen),
    previewWidth: readNumber(value.previewWidth, defaults.previewWidth),
    onboarded: readBoolean(value.onboarded, defaults.onboarded),
    onboardedSteps: readStringList(
      value.onboardedSteps,
      defaults.onboardedSteps
    ),
    pinnedThreads: readStringList(value.pinnedThreads, defaults.pinnedThreads),
    agentHarnessFilter: readStringList(
      value.agentHarnessFilter,
      defaults.agentHarnessFilter
    ),
    composerHarness: readComposerHarness(value.composerHarness),
    composerTuning: readComposerTuning(value.composerTuning),
    providerTuningImported: readStringList(
      value.providerTuningImported,
      defaults.providerTuningImported
    ),
    keybindings: readStringRecord(value.keybindings),
    conversionMode: readChoice(
      value.conversionMode,
      ["native", "transcript"],
      defaults.conversionMode
    ),
    titleOverrides: readStringRecord(value.titleOverrides),
    commitPrompt: readOptionalString(value.commitPrompt),
  }

  // The rail redesigned around showing every folder; a "workspace" scope
  // persisted under the old design would silently narrow it. One flip.
  if (value.railScopeMigrated !== true) prefs.railScope = "all"
  if (value.transcriptReplayDefaultMigrated !== true) {
    prefs.conversionMode = "transcript"
  }
  return prefs
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (!raw) return defaults
    const parsed: JsonValue = JSON.parse(raw)
    return parsePrefs(parsed) ?? defaults
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
      const stored = {
        ...prefsStore.get(),
        railScopeMigrated: true,
        transcriptReplayDefaultMigrated: true,
      }
      localStorage.setItem(KEY, JSON.stringify(stored))
    } catch {
      // A full or disabled store is not worth interrupting the session for.
    }
  })
})

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  prefsStore.set((prefs) => ({ ...prefs, [key]: value }))
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
type BooleanPref = {
  [K in keyof Prefs]-?: Prefs[K] extends boolean ? K : never
}[keyof Prefs]

/** Pin or unpin a thread by its session path, newest pin first. */
export function togglePinned(path: string) {
  const current = prefsStore.get().pinnedThreads
  setPref(
    "pinnedThreads",
    current.includes(path)
      ? current.filter((entry) => entry !== path)
      : [path, ...current]
  )
}

export function togglePref(key: BooleanPref) {
  setPref(key, !prefsStore.get()[key])
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
