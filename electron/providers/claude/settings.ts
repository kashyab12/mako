import { readFile, readdir } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { SessionSettings } from "@mako/sessions/settings"

const ClaudeSettingsSchema = z.object({
  effortLevel: z.string().optional(),
  fastMode: z.boolean().optional(),
  fastModePerSessionOptIn: z.boolean().optional(),
  env: z
    .object({
      CLAUDE_CODE_EFFORT_LEVEL: z.string().optional(),
      CLAUDE_CODE_DISABLE_FAST_MODE: z.string().optional(),
    })
    .optional(),
})
type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>

/** Only declared values are returned; the CLI owns unstated and managed defaults. */
export function claudeSettingsFromLayers(
  layers: readonly ClaudeSettings[],
  environment: NodeJS.ProcessEnv
): SessionSettings {
  const settings = layers.reduce<ClaudeSettings>(
    (merged, layer) => ({
      ...merged,
      ...layer,
      env: { ...merged.env, ...layer.env },
    }),
    {}
  )
  const env = { ...environment, ...settings.env }
  const options: NonNullable<SessionSettings["options"]> = {}
  const effort = env.CLAUDE_CODE_EFFORT_LEVEL ?? settings.effortLevel
  if (effort && effort !== "auto") options.effort = effort
  if (settings.fastMode !== undefined) options.fast = settings.fastMode
  if (
    settings.fastModePerSessionOptIn === true ||
    env.CLAUDE_CODE_DISABLE_FAST_MODE === "1"
  )
    options.fast = false
  return { options }
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  try {
    return ClaudeSettingsSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {}
    throw new Error("Claude Code settings could not be read", { cause: error })
  }
}

export async function claudeConfiguredSettings(
  env: NodeJS.ProcessEnv,
  cwd?: string
): Promise<SessionSettings> {
  // Precedence follows https://code.claude.com/docs/en/settings.
  const managedRoot =
    platform() === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform() === "win32"
        ? join(env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode")
        : "/etc/claude-code"
  const fragments = await readdir(
    join(managedRoot, "managed-settings.d")
  ).catch((error): string[] => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return []
    throw new Error("Claude Code managed settings could not be read", {
      cause: error,
    })
  })
  const paths = [
    join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"),
    ...(cwd
      ? [
          join(cwd, ".claude", "settings.json"),
          join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    join(managedRoot, "managed-settings.json"),
    ...fragments
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(managedRoot, "managed-settings.d", name)),
  ]
  return claudeSettingsFromLayers(
    await Promise.all(paths.map(readSettings)),
    env
  )
}
