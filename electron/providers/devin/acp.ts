import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"

export const devinAcpSource: ProviderAcpSource = {
  provider: "devin",
  available: () => true,
  async launch() {
    return {
      command: devinExecutable() ?? "devin",
      args: ["acp"],
      configureEnvironment: () => {},
    }
  },
}
