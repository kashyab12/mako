import {
  availableHarnessProfile,
  normalizeCodexModels,
  type CodexModelListResponse,
} from "../../harness-models.js"
import type { ProviderProfileLoader } from "../profile-loader.js"
import { rpcRequest } from "../profile-transport.js"

export const codexProfileLoader: ProviderProfileLoader = {
  provider: "codex",
  cacheKey: (env) => env.CODEX_HOME ?? "",
  async load(env) {
    const result = await rpcRequest<CodexModelListResponse>(
      "codex",
      ["app-server"],
      "model/list",
      env,
      false
    )
    return availableHarnessProfile("codex", normalizeCodexModels(result))
  },
}
