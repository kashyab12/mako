import {
  commandTuning,
  type NativeRunner,
} from "../native-runner.js"

export const claudeNativeRunner: NativeRunner = {
  provider: "claude",
  fastMode: "unsupported",
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
      ],
    }
  },
}
