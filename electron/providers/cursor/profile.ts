import { homedir } from "node:os"
import { join } from "node:path"
import {
  availableHarnessProfile,
  normalizeCursorModels,
  type CursorConfig,
  type CursorModelListResponse,
} from "../../harness-models.js"
import type { ProviderProfileLoader } from "../profile-loader.js"
import { readJson, rpcRequest } from "../profile-transport.js"

export const cursorProfileLoader: ProviderProfileLoader = {
  provider: "cursor",
  cacheKey: () => "",
  async load(env) {
    const result = await rpcRequest<CursorModelListResponse>(
      "cursor-agent",
      ["acp"],
      "cursor/list_available_models",
      env,
      true
    )
    const configured = await readJson<CursorConfig>(
      join(homedir(), ".cursor", "cli-config.json")
    )
    return availableHarnessProfile(
      "cursor",
      normalizeCursorModels(result, configured?.model?.modelId)
    )
  },
}
