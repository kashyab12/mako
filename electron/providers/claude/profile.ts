import {
  normalizeClaudeModels,
  type ClaudeModelRow,
} from "../../harness-models.js"
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
  async load(env) {
    const response = await streamRequest<
      ClaudeControlMessage,
      ClaudeModelRow[]
    >(
      "claude",
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
          : undefined
    )
    return availableProviderProfile(
      claudeProfileLoader,
      normalizeClaudeModels(response)
    )
  },
}
