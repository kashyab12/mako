import { openCodeInstallation } from "./installation.js"
import {
  commandTuning,
  type CommandTuning,
  type NativeRunner,
} from "../native-runner.js"

function tuningArgs(tuning: CommandTuning, generation: "v1" | "v2") {
  if (!tuning.model) return []
  if (generation === "v2") {
    return [
      "--model",
      tuning.cliEffort ? `${tuning.model}#${tuning.cliEffort}` : tuning.model,
    ]
  }
  return [
    "--model",
    tuning.model,
    ...(tuning.cliEffort ? ["--variant", tuning.cliEffort] : []),
  ]
}

export const openCodeNativeRunner: NativeRunner = {
  provider: "opencode",
  resume(id, prompt, options) {
    const preferred =
      options?.nativePath?.includes("#v2:") ||
      options?.nativePath?.includes("opencode-next.db#")
        ? "v2"
        : "v1"
    const installation =
      openCodeInstallation(preferred) ?? openCodeInstallation()
    const generation = installation?.generation ?? preferred
    return {
      command: installation?.command ?? "opencode",
      args: [
        "run",
        ...(generation === "v2" ? ["--auto"] : []),
        "--session",
        id,
        ...tuningArgs(commandTuning(options), generation),
        prompt,
      ],
    }
  },
  fresh(prompt, options) {
    const installation = openCodeInstallation()
    const generation = installation?.generation ?? "v1"
    return {
      command: installation?.command ?? "opencode",
      args: [
        "run",
        ...(generation === "v2" ? ["--auto"] : []),
        ...tuningArgs(commandTuning(options), generation),
        prompt,
      ],
    }
  },
}
