import { codexWireSettings } from "./settings.js"
import {
  type NativeRunner,
} from "../native-runner.js"

function tuningArgs(options: Parameters<NativeRunner["fresh"]>[1]): string[] {
  const tuning = codexWireSettings(options)
  return [
    ...(tuning.model ? ["-m", tuning.model] : []),
    ...(tuning.effort !== undefined
      ? ["-c", `model_reasoning_effort="${tuning.effort}"`]
      : []),
    ...(tuning.serviceTier !== undefined
      ? ["-c", `service_tier="${tuning.serviceTier}"`]
      : []),
  ]
}

export const codexNativeRunner: NativeRunner = {
  provider: "codex",
  fastMode: "supported",
  resume(id, prompt, options) {
    return {
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        ...tuningArgs(options ?? {}),
        "resume",
        id,
        prompt,
      ],
    }
  },
  fresh(prompt, options) {
    return {
      command: "codex",
      args: [
        "exec",
        prompt,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        ...tuningArgs(options),
      ],
    }
  },
}
