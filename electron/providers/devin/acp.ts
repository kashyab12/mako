import { prepareDevinMcp } from "./session-mcp.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"
import { devinPermissionTitle } from "./permissions.js"

export const devinAcpSource: ProviderAcpSource = {
  provider: "devin",
  canResume: false,
  available: () => devinExecutable() !== null,
  async launch() {
    return {
      command: devinExecutable() ?? "devin",
      args: ["acp"],
      configureEnvironment: () => {},
      permissionTitle: devinPermissionTitle,
      prepareMcp: prepareDevinMcp,
    }
  },
}
