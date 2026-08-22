import {
  commandTuning,
  type CommandTuning,
  type NativeRunner,
} from "../native-runner.js"

function cursorModel(tuning: CommandTuning): string | undefined {
  const parameters: string[] = []
  if (tuning.effort) parameters.push(`effort=${tuning.effort}`)
  if (tuning.fast !== undefined) parameters.push(`fast=${tuning.fast}`)
  if (!tuning.model && parameters.length === 0) return undefined
  const model = tuning.model ?? "auto"
  return parameters.length > 0
    ? `${model}[${parameters.join(",")}]`
    : model
}

export const cursorNativeRunner: NativeRunner = {
  provider: "cursor",
  fastMode: "supported",
  resume(id, prompt, options) {
    const tuning = commandTuning(options)
    return {
      command: "cursor-agent",
      args: [
        "-p",
        prompt,
        "--resume",
        id,
        "--force",
        ...(tuning.model
          ? ["--model", cursorModel(tuning) ?? tuning.model]
          : []),
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
