import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"

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
