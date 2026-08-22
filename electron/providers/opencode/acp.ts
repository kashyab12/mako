import type { ProviderAcpSource } from "../acp-source.js"
import {
  openCodeInstallation,
  openCodeSessionGeneration,
} from "./installation.js"

interface OpenCodeAcpConfig {
  model?: string
  agent?: { build: { variant: string } }
}

export const openCodeAcpSource: ProviderAcpSource = {
  provider: "opencode",
  available: () => openCodeInstallation() !== null,
  async launch(options) {
    const generation = options.resume
      ? await openCodeSessionGeneration(options.resume)
      : openCodeInstallation()?.generation
    const installation =
      openCodeInstallation(generation) ?? openCodeInstallation()
    if (!installation) return null
    return {
      command: installation.command,
      args: ["acp"],
      configureEnvironment(env) {
        if ((generation ?? installation.generation) === "v2" || !options.tuning)
          return
        const config: OpenCodeAcpConfig = {}
        if (options.tuning.model) config.model = options.tuning.model
        if (options.tuning.effort) {
          config.agent = { build: { variant: options.tuning.effort } }
        }
        if (Object.keys(config).length > 0) {
          env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
        }
      },
    }
  },
}
