import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"

export const grokAcpSource: ProviderAcpSource = {
  provider: "grok",
  available: () => resolveExecutable("grok") !== null,
  async launch(options) {
    const args = ["agent", "--no-leader"]
    if (options.tuning?.effort) {
      args.push("--reasoning-effort", options.tuning.effort)
    }
    args.push("stdio")
    return {
      command: "grok",
      args,
      configureEnvironment(env) {
        env.GROK_DISABLE_AUTOUPDATER = "1"
      },
    }
  },
}
