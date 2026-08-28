import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"

export const cursorAcpSource: ProviderAcpSource = {
  provider: "cursor",
  available: () => resolveExecutable("cursor-agent") !== null,
  async launch() {
    return {
      command: "cursor-agent",
      args: ["acp"],
      configureEnvironment: () => {},
    }
  },
}
