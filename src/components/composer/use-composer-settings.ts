import { useEffect } from "react"
import { usePrefs } from "@/state/prefs"
import { acpForThread, activeAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/thread-store"
import { useSession } from "@/state/session"
import { providerProfileKey, providers, useProviders } from "@/state/providers"
import {
  observedSessionSettings,
  resolveComposerSettingsInput,
  resolveSettingsTarget,
  settingsTargetKey,
} from "@/state/composer-settings"
import { shallowEqual } from "@/state/store"

/** Subscribe to setting facts, never transcript blocks or streaming token counts. */
export function useComposerSettings(provider?: string) {
  const harness = useThreads((state) => provider ?? state.composerHarness)
  const ref = useThreads((state) => state.opening?.ref ?? state.viewing?.ref)
  const workspace = useSession((state) => state.meta?.cwd)
  const live = useAcp((state) => {
    const conversation = ref ? acpForThread(state, ref) : activeAcp(state)
    return {
      id: conversation?.key,
      harness: conversation?.harness,
      cwd: conversation?.cwd,
      path: conversation?.threadPath,
      nativeId:
        conversation?.kind === "live"
          ? conversation.session.nativeId
          : undefined,
      settings:
        conversation?.kind === "live"
          ? conversation.session.settings
          : undefined,
      options:
        conversation?.kind === "live"
          ? conversation.session.configOptions
          : undefined,
      active: conversation?.kind === "live",
    }
  }, shallowEqual)
  const nativeRef = useThreads((state) =>
    live.nativeId
      ? state.threads.find(
          (entry) =>
            entry.harness === harness && entry.nativeId === live.nativeId
        )
      : undefined
  )
  const target = resolveSettingsTarget({ harness, ref, live, workspace })
  const key = settingsTargetKey(target)
  const overrides = usePrefs((prefs) => prefs.settingsOverrides[key])
  const preference = usePrefs((prefs) => prefs.providerSettings[harness])
  const profile = useProviders(
    (state) => state.contexts[providerProfileKey(harness, target.cwd)]
  )
  const refresh = () => providers.load(harness, true, target.cwd)
  const error = useProviders(
    (state) => state.contextErrors[providerProfileKey(harness, target.cwd)]
  )

  useEffect(() => {
    const reload = () => {
      void providers.load(harness, false, target.cwd).catch(() => {})
    }
    void providers.load(harness, false, target.cwd).catch(() => {})
    const interval = window.setInterval(reload, 300_000)
    window.addEventListener("focus", reload)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", reload)
    }
  }, [harness, target.cwd, workspace])

  const { resolved, model, options } = resolveComposerSettingsInput({
    target,
    profile,
    overrides,
    preference,
    session:
      target.kind === "new"
        ? undefined
        : live.harness === harness && live.active
          ? observedSessionSettings(
              ref ?? nativeRef,
              live.settings,
              profile?.models
            )
          : observedSessionSettings(ref, undefined),
    live:
      live.active && live.harness === harness
        ? { options: live.options }
        : undefined,
  })
  const modelLabel =
    model?.label ??
    (resolved.model.kind === "known" ? resolved.model.value : undefined) ??
    ((!profile || profile.pending) && !error ? "Loading model…" : "Model unavailable")
  return {
    target,
    profile,
    resolved,
    model,
    modelLabel,
    options,
    error,
    refresh,
  }
}

export type ComposerSettingsView = ReturnType<typeof useComposerSettings>
