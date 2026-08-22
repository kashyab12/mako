import type { HarnessProfile } from "@/lib/types"
import { prefsStore, setPref } from "@/state/prefs"
import type {
  ComposerTuning,
  HarnessOptionValues,
} from "@/state/thread-state"
import { threadsStore } from "@/state/thread-store"

const INTERACTIVE_RESUME_HARNESSES = new Set([
  "claude",
  "grok",
  "opencode",
])

export function canResumeInteractively(harness: string): boolean {
  return INTERACTIVE_RESUME_HARNESSES.has(harness)
}

/** The composer's agent, remembered across launches. */
export function setComposerHarness(harness: string) {
  threadsStore.set({ composerHarness: harness })
  setPref("composerHarness", harness)
}

/**
 * A harness's model/effort/fast choice — kept in Mako's own state, so what
 * the user picked for Codex is still picked tomorrow, whatever any CLI
 * thinks its default is.
 */
export function setComposerTuning(
  harness: string,
  patch: Partial<ComposerTuning>
) {
  const all = threadsStore.get().composerTuning
  const next = { ...all, [harness]: { ...all[harness], ...patch } }
  threadsStore.set({ composerTuning: next })
  setPref("composerTuning", next)
}

/**
 * Copy a provider's starting selection into Mako once. After this boundary,
 * provider config is discovery metadata only: Mako owns the model and option
 * values and never follows later external changes.
 */
export function initializeComposerTuning(profile: HarnessProfile): void {
  if (!profile.available) return
  const prefs = prefsStore.get()
  if (prefs.providerTuningImported.includes(profile.id)) return

  const current = threadsStore.get().composerTuning[profile.id]
  if (!hasExplicitTuning(current)) {
    const imported = tuningFromProfile(profile)
    if (!imported) return
    const next = {
      ...threadsStore.get().composerTuning,
      [profile.id]: imported,
    }
    threadsStore.set({ composerTuning: next })
    setPref("composerTuning", next)
  }
  setPref("providerTuningImported", [
    ...prefs.providerTuningImported,
    profile.id,
  ])
}

function hasExplicitTuning(tuning: ComposerTuning | undefined): boolean {
  return Boolean(
    tuning?.model ||
      tuning?.effort !== undefined ||
      tuning?.fast !== undefined ||
      (tuning?.options && Object.keys(tuning.options).length > 0)
  )
}

function tuningFromProfile(profile: HarnessProfile): ComposerTuning | null {
  const identity = profile.configuredModel ?? profile.defaultModel
  const model = profile.models.find(
    (entry) =>
      entry.id === identity ||
      entry.launchId === identity ||
      entry.aliases?.includes(identity ?? "")
  )
  if (!model) return null

  const options: HarnessOptionValues = {}
  for (const option of model.options) {
    if (option.kind === "boolean") {
      options[option.id] = option.current
      continue
    }
    const value =
      option.current ?? option.values.find((entry) => entry.default)?.value
    if (value !== undefined) options[option.id] = value
  }
  const effortOption = model.options.find(
    (option) =>
      option.kind === "select" &&
      /effort|reason/i.test(`${option.id} ${option.label}`)
  )
  const fastOption = model.options.find((option) =>
    /fast|speed/i.test(`${option.id} ${option.label}`)
  )
  const effort =
    effortOption?.kind === "select" ? options[effortOption.id] : undefined
  const fast = fastOption ? options[fastOption.id] : undefined
  const imported: ComposerTuning = { model: model.id }
  if (effort !== undefined && effort !== true && effort !== false) {
    imported.effort = effort
  }
  if (fast !== undefined) imported.fast = fast === true || fast === "true"
  if (Object.keys(options).length > 0) imported.options = options
  return imported
}
