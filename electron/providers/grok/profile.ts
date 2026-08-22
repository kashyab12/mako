import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  availableHarnessProfile,
  normalizeGrokModels,
  type GrokModelCache,
} from "../../harness-models.js"
import type { ProviderProfileLoader } from "../profile-loader.js"
import { readJson, runDiscovery } from "../profile-transport.js"

export const grokProfileLoader: ProviderProfileLoader = {
  provider: "grok",
  cacheKey: () => "",
  async load(env) {
    const installed = join(homedir(), ".grok", "bin", "grok")
    const executable = existsSync(installed) ? installed : "grok"
    const output = await runDiscovery(executable, ["models"], env)
    const cached = await readJson<GrokModelCache>(
      join(homedir(), ".grok", "models_cache.json")
    )
    return availableHarnessProfile("grok", normalizeGrokModels(output, cached))
  },
}
