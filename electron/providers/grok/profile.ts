import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  normalizeGrokModels,
  type GrokModelCache,
} from "../../harness-models.js"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { readJson, runDiscovery } from "../profile-transport.js"

export const grokProfileLoader: ProviderProfileLoader = {
  provider: "grok",
  label: "Grok",
  transport: "acp",
  capabilities: [
    "start",
    "resume",
    "fork",
    "stream",
    "interrupt",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
    "memory",
  ],
  cacheKey: () => "",
  async load(env) {
    const installed = join(homedir(), ".grok", "bin", "grok")
    const executable = existsSync(installed) ? installed : "grok"
    const output = await runDiscovery(executable, ["models"], env)
    const cached = await readJson<GrokModelCache>(
      join(homedir(), ".grok", "models_cache.json")
    )
    return availableProviderProfile(
      grokProfileLoader,
      normalizeGrokModels(output, cached)
    )
  },
}
