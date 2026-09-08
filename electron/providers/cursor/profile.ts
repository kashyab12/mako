import { homedir } from "node:os"
import { join } from "node:path"
import { normalizeCursorModels, type CursorConfig, type CursorModelListResponse } from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { readJson, rpcRequest } from "../profile-transport.js"

export const cursorProfileLoader: ProviderProfileLoader = {
  provider: "cursor",
  label: "Cursor",
  transport: "acp",
  capabilities: [
    "start",
    "resume-acp",
    "stream",
    "interrupt",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
  ],
  cacheKey: () => "",
  async load(env, cwd) {
    const result = await rpcRequest<CursorModelListResponse>(
      "cursor-agent",
      ["acp"],
      "cursor/list_available_models",
      env,
      true,
      {},
      cwd
    )
    const configured = await readJson<CursorConfig>(
      join(homedir(), ".cursor", "cli-config.json")
    )
    return availableProviderProfile(
      cursorProfileLoader,
      normalizeCursorModels(result, configured?.model?.modelId)
    )
  },
}
