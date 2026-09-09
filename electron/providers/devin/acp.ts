import { prepareDevinMcp } from "./session-mcp.js"
import { devinResumePolicy } from "./resume.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"
import { devinPermissionTitle } from "./permissions.js"

export const devinAcpSource: ProviderAcpSource = {
  ...devinResumePolicy(),
  provider: "devin",
  canResume: true,
  steering: "concurrent-prompt",
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
