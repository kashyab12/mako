import { query } from "@anthropic-ai/claude-agent-sdk"
import { resolveExecutable } from "../../executable.js"
import { createClaudeSdkDriver } from "./sdk-driver.js"

export const claudeLiveDriver = createClaudeSdkDriver({
  available: () =>
    resolveExecutable(process.env.CLAUDE_CODE_EXECUTABLE ?? "claude") !== null,
  configure: async (...args) =>
    (await import("./sdk-options.js")).claudeSdkOptions(...args),
  query,
})
