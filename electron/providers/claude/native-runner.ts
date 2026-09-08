import {
  commandTuning,
  type NativeRunner,
} from "../native-runner.js"

export const claudeNativeRunner: NativeRunner = {
  provider: "claude",
  fastMode: "supported",
  resume(id, prompt, options) {
    const tuning = commandTuning(options)
    return {
      command: "claude",
      args: [
        "-p",
        prompt,
        "--resume",
        id,
        "--dangerously-skip-permissions",
        ...(tuning.model ? ["--model", tuning.model] : []),
        ...(tuning.effort ? ["--effort", tuning.effort] : []),
        ...(tuning.fast !== undefined ? ["--settings", JSON.stringify({ fastMode: tuning.fast })] : []),
      ],
    }
  },
  fresh(prompt, options) {
    const tuning = commandTuning(options)
    return {
      command: "claude",
      args: [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        ...(tuning.model ? ["--model", tuning.model] : []),
        ...(tuning.effort ? ["--effort", tuning.effort] : []),
        ...(tuning.fast !== undefined ? ["--settings", JSON.stringify({ fastMode: tuning.fast })] : []),
      ],
    }
  },
}
