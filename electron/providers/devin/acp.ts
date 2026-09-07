import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"

export const devinAcpSource: ProviderAcpSource = {
  provider: "devin",
  canResume: false,
  available: () => devinExecutable() !== null,
  async launch() {
    return {
      command: devinExecutable() ?? "devin",
      args: ["acp"],
      configureEnvironment: () => {},
    }
  },
}
