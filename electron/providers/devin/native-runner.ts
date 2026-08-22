import { devinExecutable } from "./executable.js"
import {
  commandTuning,
  type NativeRunner,
} from "../native-runner.js"

export const devinNativeRunner: NativeRunner = {
  provider: "devin",
  fastMode: "supported",
  resume(id, prompt, options) {
    const tuning = commandTuning(options)
    return {
      command: devinExecutable() ?? "devin",
      args: [
        "-p",
        prompt,
        "--resume",
        id,
        "--permission-mode",
        "smart",
        "--respect-workspace-trust",
        "false",
        ...(tuning.model ? ["--model", tuning.model] : []),
      ],
    }
  },
  fresh(prompt, options) {
    const tuning = commandTuning(options)
    return {
      command: devinExecutable() ?? "devin",
      args: [
        "-p",
        prompt,
        "--permission-mode",
        "smart",
        "--respect-workspace-trust",
        "false",
        ...(tuning.model ? ["--model", tuning.model] : []),
      ],
    }
  },
}
