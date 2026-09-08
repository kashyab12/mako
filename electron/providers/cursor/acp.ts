import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { cursorNotifications } from "./acp-notifications.js"

export const cursorAcpSource: ProviderAcpSource = {
  provider: "cursor",
  canResume: false,
  available: () => resolveExecutable("cursor-agent") !== null,
  async launch() {
    return {
      command: "cursor-agent",
      args: ["acp"],
      configureEnvironment: () => {},
      notifications: cursorNotifications(),
    }
  },
}
