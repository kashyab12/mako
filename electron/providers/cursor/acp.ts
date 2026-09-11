import { resolveExecutable } from "../../executable.js"
import type { ProviderAcpSource } from "../acp-source.js"

export const cursorAcpSource: ProviderAcpSource = {
  provider: "cursor",
  clientCapabilities: { _meta: { parameterizedModelPicker: true } },
  canResume: false,
  // Verified 2026-09-11: a second session/prompt makes cursor-agent cancel the
  // running step (stopReason "cancelled") and continue with the new message.
  steering: "interrupting-prompt",
  // cursor-agent advertises agent/plan/ask and asks for every command and
  // edit in agent mode; its --force/--yolo flags are ignored under `acp`.
  access: {
    native: { ask: "agent", plan: "plan", chat: "ask" },
    host: ["edits", "full"],
    base: "agent",
  },
  available: () => resolveExecutable("cursor-agent") !== null,
  async launch() {
    return {
      command: "cursor-agent",
      args: ["acp"],
      configureEnvironment: () => {},
    }
  },
}
