import { resolveCodexExecutable } from "./executable.js"
import {
  normalizeCodexModels,
  type CodexModelListResponse,
} from "../../harness-models.js"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { rpcRequest } from "../profile-transport.js"

export const codexProfileLoader: ProviderProfileLoader = {
  provider: "codex",
  label: "Codex",
  transport: "app-server",
  capabilities: [
    "start",
    "resume",
    "fork-at-turn",
    "stream",
    "steer",
    "interrupt",
    "permissions",
    "images",
    "audio",
    "skills",
    "mcp",
    "models",
    "review",
  ],
  cacheKey: (env) => `${env.CODEX_HOME ?? ""}\0${env.CODEX_EXECUTABLE ?? ""}`,
  async load(env) {
    const executable = await resolveCodexExecutable(env)
    if (!executable) throw new Error("The selected Codex executable is not available")
    const result = await rpcRequest<CodexModelListResponse>(
      executable,
      ["app-server"],
      "model/list",
      env,
      false
    )
    return availableProviderProfile(
      codexProfileLoader,
      normalizeCodexModels(result)
    )
  },
}
