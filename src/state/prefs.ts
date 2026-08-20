import { createHook, createStore } from "@/state/store"

/**
 * Durable UI preferences. Written through a microtask-batched save so that
 * dragging a panel divider does not hit localStorage on every frame.
 */

export type Theme = "dark" | "light" | "system"

/** What the left rail is showing: your conversations, or the project. */
export type RailMode = "threads" | "agents" | "files"

/** How the session rail is scoped and grouped, mirroring ORCA's sidebar model. */
export type RailScope = "workspace" | "all"
export type RailSortBy = "recent" | "created" | "name" | "size"

interface PreferenceStringMap {
  [key: string]: string
}

/** Dragged companion-card widths, keyed by surface id. */
interface SurfaceWidthMap {
  [surfaceId: string]: number
}

export interface Prefs {
  theme: Theme
  railOpen: boolean
  railWidth: number
  /** Dragged companion-card widths, per surface id — a spatial habit. */
  surfaceWidths: SurfaceWidthMap
  surfaceHeights: SurfaceWidthMap
  /** What ⌘I reopens, and what boot restores. Tab ids don't survive a relaunch. */
  lastCompanion: string | null
  /** `provider/id` keys, most recent first. */
  favoriteModels: string[]
  recentModels: string[]
  showThinking: boolean
  denseTools: boolean
  railMode: RailMode
  railScope: RailScope
  railSortBy: RailSortBy
  collapsedGroups: string[]
  collapsedDirs: string[]
  /** Folders open in the project tree. Keys are folded paths, not path prefixes. */
  openDirs: string[]
  autoOpenDiff: boolean
  /** The getting-started list is finished or dismissed, and will not return. */
  onboarded: boolean
  /** Checklist steps that have been true at least once. Done is done. */
  onboardedSteps: string[]
  /** Threads kept at the top of both rails, by session path. */
  pinnedThreads: string[]
  pinnedProjects: string[]
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
  terminalOptionAsMeta: "auto" | "on" | "off"
  /**
   * How a conversation moves to another harness. Transcript replay is the
   * loss-aware default; session import is the compatibility path for stores
   * that accept synthesized history.
   */
  conversionMode: "native" | "transcript"
  /** Your names for threads, by path — native stores don't take renames. */
  titleOverrides: PreferenceStringMap
  /** Your names for persistent terminal sessions, by daemon id. */
  terminalTitles: PreferenceStringMap
  /** Overrides the host's default commit-drafting prompt. */
  commitPrompt?: string
}

const KEY = "mako.prefs.v1"
const LEGACY_KEY = "pi.prefs.v1"

const defaults: Prefs = {
  theme: "dark",
  railOpen: true,
  railWidth: 264,
  surfaceWidths: {},
  surfaceHeights: {},
  lastCompanion: "changes",
  favoriteModels: [],
  recentModels: [],
  showThinking: true,
  denseTools: false,
  railMode: "threads",
  railScope: "all",
  railSortBy: "recent",
  collapsedGroups: [],
  collapsedDirs: [],
  openDirs: [],
  autoOpenDiff: true,
  onboarded: false,
  onboardedSteps: [],
  pinnedThreads: [],
  pinnedProjects: [],
  agentHarnessFilter: [],
  composerTuning: {},
  providerTuningImported: [],
  keybindings: {},
  terminalOptionAsMeta: "auto",
  titleOverrides: {},
  terminalTitles: {},
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

function readNumberRecord(value: StoredValue): SurfaceWidthMap {
  if (!isJsonObject(value)) return {}
  const record: SurfaceWidthMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonNumber(entry)) record[key] = entry
  }
  return record
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

/**
 * One-shot migrations from the inspector-era prefs: the dragged inspector
 * and preview widths seed the matching surface widths, and a deliberately
 * closed inspector stays closed at boot.
 */
function readSurfaceWidths(value: JsonObject): SurfaceWidthMap {
  const stored = readNumberRecord(value.surfaceWidths)
  if (Object.keys(stored).length > 0) return stored
  const seeded: SurfaceWidthMap = {}
  if (isJsonNumber(value.inspectorWidth)) seeded.changes = value.inspectorWidth
  if (isJsonNumber(value.previewWidth)) seeded.preview = value.previewWidth
  return seeded
}

function readLastCompanion(value: JsonObject): string | null {
  if (isJsonString(value.lastCompanion)) return value.lastCompanion
  if (value.lastCompanion === null || value.inspectorOpen === false) return null
  if (isJsonString(value.inspectorTab)) return value.inspectorTab
  return defaults.lastCompanion
}

function parsePrefs(value: JsonValue): Prefs | null {
  if (!isJsonObject(value)) return null
  const prefs: Prefs = {
    theme: readChoice(value.theme, ["dark", "light", "system"], defaults.theme),
    railOpen: readBoolean(value.railOpen, defaults.railOpen),
    railWidth: readNumber(value.railWidth, defaults.railWidth),
    surfaceWidths: readSurfaceWidths(value),
    surfaceHeights: readNumberRecord(value.surfaceHeights),
    lastCompanion: readLastCompanion(value),
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
    railSortBy: readChoice(
      value.railSortBy,
      ["recent", "created", "name", "size"],
      defaults.railSortBy
    ),
    collapsedGroups: readStringList(
      value.collapsedGroups,
      defaults.collapsedGroups
    ),
    collapsedDirs: readStringList(value.collapsedDirs, defaults.collapsedDirs),
    openDirs: readStringList(value.openDirs, defaults.openDirs),
    autoOpenDiff: readBoolean(value.autoOpenDiff, defaults.autoOpenDiff),
    onboarded: readBoolean(value.onboarded, defaults.onboarded),
    onboardedSteps: readStringList(
      value.onboardedSteps,
      defaults.onboardedSteps
    ),
    pinnedThreads: readStringList(value.pinnedThreads, defaults.pinnedThreads),
    pinnedProjects: readStringList(value.pinnedProjects, defaults.pinnedProjects),
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
    terminalOptionAsMeta: readChoice(
      value.terminalOptionAsMeta,
      ["auto", "on", "off"],
      defaults.terminalOptionAsMeta
    ),
    conversionMode: readChoice(
      value.conversionMode,
      ["native", "transcript"],
      defaults.conversionMode
    ),
    titleOverrides: readStringRecord(value.titleOverrides),
    terminalTitles: readStringRecord(value.terminalTitles),
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

export function togglePinnedProject(path: string) {
  const current = prefsStore.get().pinnedProjects
  setPref(
    "pinnedProjects",
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
    const { theme } = prefsStore.get()
    const light = theme === "light" || (theme === "system" && media.matches)
    document.documentElement.classList.toggle("light", light)
    document.documentElement.style.colorScheme = light ? "light" : "dark"
  }
  paint()
  const off = prefsStore.subscribe(paint)
  media.addEventListener("change", paint)
  return () => {
    off()
    media.removeEventListener("change", paint)
  }
}
