import {
  normalizeDevinModels,
  type DevinModelListResponse,
} from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { runDiscovery } from "../profile-transport.js"
import { devinExecutable } from "./executable.js"
import { devinDefaultModel } from "./settings.js"
import { homedir } from "node:os"

export const devinProfileLoader: ProviderProfileLoader = {
  provider: "devin",
  label: "Devin",
  transport: "acp",
  capabilities: [
    "start",
    "resume",
    "stream",
    "interrupt",
    "steer",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
  ],
  cacheKey: () => "",
  async load(env, cwd) {
    const executable = devinExecutable()
    if (!executable) throw new Error("Devin CLI is not installed")
    const parsed: DevinModelListResponse = JSON.parse(
      await runDiscovery(
        executable,
        ["models", "list", "--format", "json"],
        env,
        undefined,
        cwd
      )
    )
    parsed.default_model = await devinDefaultModel(
      executable,
      env,
      cwd ?? homedir()
    )
    return availableProviderProfile(
      devinProfileLoader,
      normalizeDevinModels(parsed)
    )
  },
}
