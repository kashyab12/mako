import { claudeResolvedSettings } from "./settings.js"
import type { SessionSettings } from "@mako/sessions/settings"
import {
  normalizeClaudeModels,
  type ClaudeModelRow,
} from "@mako/sessions/model-catalog"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { streamRequest } from "../profile-transport.js"

interface ClaudeControlMessage {
  type?: string
  response?: {
    subtype?: string
    response?: { models?: ClaudeModelRow[] }
  }
}

export const claudeProfileLoader: ProviderProfileLoader = {
  provider: "claude",
  label: "Claude Code",
  transport: "sdk",
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
  async load(env, cwd) {
    const response = await streamRequest<
      ClaudeControlMessage,
      ClaudeModelRow[]
    >(
      env.CLAUDE_CODE_EXECUTABLE ?? "claude",
      [
        "-p",
        "--no-session-persistence",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      {
        type: "control_request",
        request_id: "mako-model-discovery",
        request: { subtype: "list_models" },
      },
      env,
      (message) =>
        message.type === "control_response" &&
        message.response?.subtype === "success"
          ? message.response.response?.models
          : undefined,
      cwd
    )
    const catalog = normalizeClaudeModels(response)
    for (const model of catalog.models) {
      for (const option of model.options)
        option.change = option.id === "agentTeams" ? "launch" : undefined
    }
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
  },
}
