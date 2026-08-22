import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderAcpSource } from "../acp-source.js"

export const grokAcpSource: ProviderAcpSource = {
  provider: "grok",
  available: () => true,
  async launch(options) {
    const installed = join(homedir(), ".grok", "bin", "grok")
    const args = ["agent", "--no-leader"]
    if (options.tuning?.effort) {
      args.push("--reasoning-effort", options.tuning.effort)
    }
    args.push("stdio")
    return {
      command: existsSync(installed) ? installed : "grok",
      args,
      configureEnvironment(env) {
        env.GROK_DISABLE_AUTOUPDATER = "1"
      },
    }
  },
}
