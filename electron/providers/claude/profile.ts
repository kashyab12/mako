import {
  availableHarnessProfile,
  normalizeClaudeModels,
  type ClaudeModelRow,
} from "../../harness-models.js"
import { streamRequest } from "../profile-transport.js"
import type { ProviderProfileLoader } from "../profile-loader.js"

interface ClaudeControlMessage {
  type?: string
  response?: {
    subtype?: string
    response?: { models?: ClaudeModelRow[] }
  }
}

export const claudeProfileLoader: ProviderProfileLoader = {
  provider: "claude",
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
    return availableHarnessProfile("claude", normalizeClaudeModels(response))
  },
}
