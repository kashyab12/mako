import { claudeConfiguredSettings } from "./settings.js"
import { normalizeClaudeModels, type ClaudeModelRow } from "@mako/sessions/model-catalog"
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
      for (const option of model.options) option.change = "launch"
    }
    try {
      catalog.settings = { ...await claudeConfiguredSettings(env, cwd), model: catalog.defaultModel }
    } catch {
      catalog.settings = { model: catalog.defaultModel }
      catalog.configurationError = "Claude Code settings could not be read. Unreported values remain unknown."
    }
    return availableProviderProfile(claudeProfileLoader, catalog)
  },
}
