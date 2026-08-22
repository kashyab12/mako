import type { ProviderCapability } from "./registry.js"

export interface NativeRunOptions {
  captureOutput?: boolean
  model?: string
  effort?: string
  fast?: boolean
  options?: Record<string, string | boolean>
  nativePath?: string
}

export interface NativeCommand {
  command: string
  args: string[]
}

export interface NativeRunner extends ProviderCapability {
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
  if (options.effort !== undefined) tuning.effort = options.effort
  if (options.effort || optionEffort !== undefined) {
    tuning.cliEffort = options.effort ?? optionEffort
  }
  if (options.fast !== undefined) tuning.fast = options.fast
  if (serviceTier !== undefined) tuning.serviceTier = serviceTier
  return tuning
}
