import { z } from "zod"
import { streamRequest } from "../profile-transport.js"

// Strip every unrelated effective setting here: this response may contain secrets.
const EffectiveSettingsSchema = z.object({
  applied: z.object({ effort: z.string().nullable().optional() }),
  effective: z.object({
    fastMode: z.boolean().optional(),
    fastModePerSessionOptIn: z.boolean().optional(),
  }),
})
export async function claudeResolvedSettings(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  model: string
) {
  return streamRequest<unknown, { effort?: string; fast?: boolean }>(
    env.CLAUDE_CODE_EXECUTABLE ?? "claude",
    [
      "-p",
      "--no-session-persistence",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
    ],
    {
      type: "control_request",
      request_id: "mako-settings",
      request: { subtype: "get_settings" },
    },
    env,
    (message) => {
      const parsed = ClaudeSettingsResponseSchema.safeParse(message)
      return parsed.success ? parsed.data : undefined
    },
    cwd
  )
}

const SettingsResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    subtype: z.literal("success"),
    response: EffectiveSettingsSchema,
  }),
})
export const ClaudeSettingsResponseSchema = SettingsResponseSchema.transform(
  (envelope) => {
    const settings = envelope.response.response
    return {
      effort: settings.applied.effort ?? undefined,
      fast:
        settings.effective.fastMode === true &&
        settings.effective.fastModePerSessionOptIn !== true,
    }
  }
)
