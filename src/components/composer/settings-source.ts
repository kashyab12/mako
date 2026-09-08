import type { ResolvedSetting, SettingSource } from "@mako/sessions/settings"

const labels = {
  override: "Selected for the next turn",
  saved: "Your saved choice for new threads",
  legacy:
    "Previously saved in Mako. Use provider defaults to follow your current configuration.",
  session: "Reported by this session",
  provider: "From this provider's workspace configuration",
  "model-default": "Default for the selected model",
} satisfies Record<SettingSource, string>

export function settingSourceLabel(setting: ResolvedSetting): string {
  return setting.kind === "known"
    ? labels[setting.source]
    : "The provider has not reported this value"
}
