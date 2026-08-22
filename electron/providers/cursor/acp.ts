import type { ProviderAcpSource } from "../acp-source.js"

export const cursorAcpSource: ProviderAcpSource = {
  provider: "cursor",
  available: () => true,
  async launch() {
    return {
      command: "cursor-agent",
      args: ["acp"],
      configureEnvironment: () => {},
    }
  },
}
