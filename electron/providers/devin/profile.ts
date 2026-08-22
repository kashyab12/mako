import {
  availableHarnessProfile,
  normalizeDevinModels,
  type DevinModelListResponse,
} from "../../harness-models.js"
import type { ProviderProfileLoader } from "../profile-loader.js"
import { runDiscovery } from "../profile-transport.js"
import { devinExecutable } from "./executable.js"

export const devinProfileLoader: ProviderProfileLoader = {
  provider: "devin",
  cacheKey: () => "",
  async load(env) {
    const executable = devinExecutable()
    if (!executable) throw new Error("Devin CLI is not installed")
    const parsed: DevinModelListResponse = JSON.parse(
      await runDiscovery(executable, ["models", "list", "--format", "json"], env)
    )
    return availableHarnessProfile("devin", normalizeDevinModels(parsed))
  },
}
