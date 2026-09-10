import { claudeDiscoveryArgs, claudeResolvedSettings } from "./settings.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { normalizeClaudeModels } from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { streamRequest } from "../profile-transport.js"

import { z } from "zod"

const ControlResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({ subtype: z.string(), response: z.unknown().optional() }),
})
const ModelsSchema = z.object({
  models: z.array(
    z.object({
      value: z.string(),
      resolvedModel: z.string().optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      supportsEffort: z.boolean().optional(),
      supportedEffortLevels: z.array(z.string()).optional(),
      supportsFastMode: z.boolean().optional(),
    })
  ),
})

const catalogues = new Map<
  string,
  Promise<ReturnType<typeof normalizeClaudeModels>>
>()
const catalogueKey = (env: NodeJS.ProcessEnv, cwd?: string) =>
  `${env.CLAUDE_CONFIG_DIR ?? ""}:${cwd ?? ""}`

async function readCatalogue(env: NodeJS.ProcessEnv, cwd?: string) {
  const response = await streamRequest(
    env.CLAUDE_CODE_EXECUTABLE ?? "claude",
    claudeDiscoveryArgs,
    {
      type: "control_request",
      request_id: "mako-model-discovery",
      request: { subtype: "list_models" },
    },
    env,
    (message) => {
      const parsed = ControlResponseSchema.safeParse(message)
      if (!parsed.success) return undefined
      if (parsed.data.response.subtype !== "success")
        throw new Error("Claude model discovery was rejected")
      return ModelsSchema.parse(parsed.data.response.response).models
    },
    cwd,
    "launch"
  )
  return normalizeClaudeModels(response)
}

export const claudeProfileLoader: ProviderProfileLoader = {
  provider: "claude",
  label: "Claude Code",
  transport: "sdk",
  nativeModelIds: true,
  capabilities: [
    "start",
    "resume",
    "fork",
    "stream",
    "interrupt",
    "steer",
    "compact",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
    "agent-teams",
  ],
  cacheKey: (env) => env.CLAUDE_CONFIG_DIR ?? "",
  async loadForSend(env, cwd) {
    const catalog = await (catalogues.get(catalogueKey(env, cwd)) ??
      readCatalogue(env, cwd))
    return availableProviderProfile(claudeProfileLoader, catalog)
  },
  async load(env, cwd) {
    const key = catalogueKey(env, cwd)
    const request = readCatalogue(env, cwd)
    catalogues.set(key, request)
    try {
      const catalog = structuredClone(await request)
      // One CLI launch per model, side by side: in sequence these four probes
      // were the longest wait in the whole provider list.
      await Promise.all(
        catalog.models.map(async (model) => {
          try {
            const settings = await claudeResolvedSettings(env, cwd, model.id)
            for (const option of model.options) {
              if (option.id === "effort" && option.kind === "select")
                option.current = settings.effort
              if (option.id === "fast" && option.kind === "boolean")
                option.current = option.disabledReason ? false : settings.fast
            }
            if (model.id === catalog.defaultModel) {
              const options: NonNullable<SessionSettings["options"]> = {}
              if (settings.effort) options.effort = settings.effort
              const speed = model.options.find((option) => option.id === "fast")
              if (speed?.current !== undefined) options.fast = speed.current
              catalog.settings = { model: model.id, options }
            }
          } catch {
            catalog.configurationError =
              "Claude Code could not report all model defaults. Unreported values remain unknown."
          }
        })
      )
      return availableProviderProfile(claudeProfileLoader, catalog)
    } finally {
      if (catalogues.get(key) === request) catalogues.delete(key)
    }
  },
}
