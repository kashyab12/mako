import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderCapability } from "./registry.js"

export interface NativeRunOptions extends SessionSettings {
  captureOutput?: boolean
  nativePath?: string
}

export interface NativeCommand {
  command: string
  args: string[]
}

export interface NativeRunner extends ProviderCapability {
  fastMode: "supported" | "unsupported"
  resume(
    id: string,
    prompt: string,
    options?: NativeRunOptions
  ): NativeCommand
  fresh(prompt: string, options: NativeRunOptions): NativeCommand
}

export interface CommandTuning {
  model?: string
  effort?: string
  cliEffort?: string
  fast?: boolean
  serviceTier?: string
}

function stringOption(
  value: string | boolean | undefined
): string | undefined {
  if (value === undefined || value === true || value === false) return undefined
  return value
}

export function commandTuning(
  options: NativeRunOptions | undefined
): CommandTuning {
  if (!options) return {}
  const tuning: CommandTuning = {}
  const optionEffort = stringOption(options.options?.effort)
  const serviceTier = stringOption(options.options?.serviceTier)
  if (options.model !== undefined) tuning.model = options.model
  if (optionEffort !== undefined) {
    tuning.effort = optionEffort
    tuning.cliEffort = optionEffort
  }
  const fast = options.options?.fast
  if (fast === true || fast === false) tuning.fast = fast
  if (serviceTier !== undefined) tuning.serviceTier = serviceTier
  return tuning
}
