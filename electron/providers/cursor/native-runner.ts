import {
  commandTuning,
  type CommandTuning,
  type NativeRunner,
} from "../native-runner.js"

function cursorModel(tuning: CommandTuning): string | undefined {
  if (!tuning.model && tuning.effort === undefined && tuning.fast === undefined)
    return undefined
  const identity = tuning.model ?? "auto"
  const bracket = identity.indexOf("[")
  const base = bracket < 0 ? identity : identity.slice(0, bracket)
  const parameters = new Map<string, string>()
  if (bracket >= 0 && identity.endsWith("]")) {
    for (const entry of identity.slice(bracket + 1, -1).split(",")) {
      const separator = entry.indexOf("=")
      if (separator < 0) parameters.set(entry, "")
      else parameters.set(entry.slice(0, separator), entry.slice(separator + 1))
    }
  }
  if (tuning.effort) parameters.set("effort", tuning.effort)
  if (tuning.fast !== undefined) parameters.set("fast", String(tuning.fast))
  const suffix = [...parameters]
    .map(([key, value]) => (value ? `${key}=${value}` : key))
    .join(",")
  return suffix ? `${base}[${suffix}]` : base
}

export const cursorNativeRunner: NativeRunner = {
  provider: "cursor",
  fastMode: "supported",
  resume(id, prompt, options) {
    const model = cursorModel(commandTuning(options))
    return {
      command: "cursor-agent",
      args: [
        "-p",
        prompt,
        "--resume",
        id,
        "--force",
        ...(model ? ["--model", model] : []),
      ],
    }
  },
  fresh(prompt, options) {
    const model = cursorModel(commandTuning(options))
    return {
      command: "cursor-agent",
      args: ["-p", prompt, "--force", ...(model ? ["--model", model] : [])],
    }
  },
}
