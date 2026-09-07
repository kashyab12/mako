import { resolveExecutable } from "../../executable.js"
import type { ProviderLiveDriver } from "../live-driver.js"

export const codexLiveDriver: ProviderLiveDriver = {
  provider: "codex",
  canResume: true,
  available: () => Boolean(resolveExecutable("codex")),
  start: async (...args) =>
    (await import("../../codex-app.js")).codexAppStart(...args),
  prompt: async (...args) =>
    (await import("../../codex-app.js")).codexAppPrompt(...args),
  permission: async (...args) => {
    ;(await import("../../codex-app.js")).codexAppPermission(...args)
  },
  cancel: async (id) => (await import("../../codex-app.js")).codexAppCancel(id),
  close: (id) => {
    void import("../../codex-app.js").then((module) => module.codexAppClose(id))
  },
  setMode: async () => {
    throw new Error(
      "This provider uses model configuration instead of session modes"
    )
  },
}
