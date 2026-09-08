import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { z } from "zod"

interface ClaudeSdkExtraArgs {
  effort?: string
  settings?: string
}
interface ClaudeSdkOptions {
  model?: string
  extraArgs: ClaudeSdkExtraArgs
}

function adapterPath(appPath: string): string {
  return join(
    appPath,
    "node_modules",
    "@zed-industries",
    "claude-code-acp",
    "dist",
    "index.js"
  )
}

export const claudeAcpSource: ProviderAcpSource = {
  provider: "claude",
  canResume: true,
  launchOptionIds: ["effort", "fast", "agentTeams"],
  sessionMetadata(tuning) {
    const effort = z.string().optional().parse(tuning.options?.effort)
    const fast = z.boolean().optional().parse(tuning.options?.fast)
    const extraArgs: ClaudeSdkExtraArgs = {}
    if (effort) extraArgs.effort = effort
    if (fast !== undefined)
      extraArgs.settings = JSON.stringify({ fastMode: fast })
    const options: ClaudeSdkOptions = { extraArgs }
    if (tuning.model) options.model = tuning.model
    return { claudeCode: { options } }
  },
  available: (appPath) =>
    existsSync(adapterPath(appPath)) &&
    resolveExecutable(process.env.CLAUDE_CODE_EXECUTABLE ?? "claude") !== null,
  async launch(options) {
    const script = adapterPath(options.appPath)
    if (!existsSync(script)) return null
    return {
      command: options.execPath,
      args: [script],
      configureEnvironment(env) {
        env.ELECTRON_RUN_AS_NODE = "1"
        if (options.tuning?.options?.agentTeams === true) {
          env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
        }
        if (!env.CLAUDE_CODE_EXECUTABLE) {
          const installed = resolveExecutable("claude", env)
          if (installed) env.CLAUDE_CODE_EXECUTABLE = installed
        }
      },
    }
  },
}
