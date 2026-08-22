import {
  commandTuning,
  type NativeRunner,
} from "../native-runner.js"

function tuningArgs(options: Parameters<NativeRunner["fresh"]>[1]): string[] {
  const tuning = commandTuning(options)
  return [
    ...(tuning.model ? ["--model", tuning.model] : []),
    ...(tuning.cliEffort !== undefined
      ? ["--reasoning-effort", tuning.cliEffort]
      : []),
  ]
}

export const grokNativeRunner: NativeRunner = {
  provider: "grok",
  fastMode: "supported",
  resume(id, prompt, options) {
    return {
      command: "agent",
      args: [
        "-p",
        prompt,
        "--resume",
        id,
        "--always-approve",
        ...tuningArgs(options ?? {}),
      ],
    }
  },
  fresh(prompt, options) {
    return {
      command: "agent",
      args: [
        "-p",
        prompt,
        "--always-approve",
        ...tuningArgs(options),
      ],
    }
  },
}
