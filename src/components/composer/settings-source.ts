import type {
  ModelOption,
  ResolvedSetting,
  SettingSource,
  SettingValue,
} from "@mako/sessions/settings"

const labels = {
  override: "Selected for the next turn",
  saved: "Your saved choice for new threads",
  legacy:
    "Previously saved in Mako. Use provider defaults to follow your current configuration.",
  session: "Reported by this session",
  provider: "From this provider's workspace configuration",
  "model-default": "Default for the selected model",
} satisfies Record<SettingSource, string>

export function settingValueLabel(
  option: ModelOption,
  value: SettingValue
): string {
  if (option.role === "speed") {
    if (option.kind === "boolean") return value === true ? "Fast" : "Standard"
    if (option.booleanValues?.on === value) return "Fast"
    if (option.booleanValues?.off === value) return "Standard"
  }
  if (option.kind === "boolean") return value === true ? "On" : "Off"
  return (
    option.values.find((entry) => entry.value === value)?.label ?? String(value)
  )
}

export function settingSourceLabel(setting: ResolvedSetting): string {
  return setting.kind === "known"
    ? labels[setting.source]
    : "The provider has not reported this value"
}
