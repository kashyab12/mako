import { statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  normalizeOpenCodeModels,
  preferredOpenCodeDefault,
  type OpenCodeModelRow,
} from "../../harness-models.js"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { runDiscovery } from "../profile-transport.js"
import { openCodeInstallation } from "./installation.js"

const ModelSchema = z.object({
  id: z.string(),
  providerID: z.string(),
  name: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  variants: z
    .record(
      z.string(),
      z.object({ reasoningEffort: z.string().optional() }).passthrough()
    )
    .optional(),
  limit: z
    .object({ context: z.number().optional(), output: z.number().optional() })
    .optional(),
  capabilities: z
    .object({
      reasoning: z.boolean().optional(),
      input: z
        .object({ text: z.boolean().optional(), image: z.boolean().optional() })
        .optional(),
    })
    .optional(),
})

const CacheModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    status: z.string().optional(),
    reasoning: z.boolean().optional(),
    reasoning_options: z
      .union([
        z.record(z.string(), z.unknown()),
        z.array(
          z.object({
            type: z.string(),
            values: z.array(z.string()),
          })
        ),
      ])
      .optional(),
    attachment: z.boolean().optional(),
    limit: z
      .object({
        context: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
  })
  .passthrough()

const CacheProviderSchema = z
  .object({ models: z.record(z.string(), z.unknown()) })
  .passthrough()
const CacheSchema = z.record(z.string(), z.unknown())
const ConfigSchema = z.object({ model: z.string().optional() }).passthrough()

export const openCodeProfileLoader: ProviderProfileLoader = {
  provider: "opencode",
  label: "OpenCode",
  transport: "acp",
  capabilities: [
    "start",
    "resume",
    "fork",
    "stream",
    "steer",
    "interrupt",
    "permissions",
    "images",
    "commands",
    "mcp",
    "models",
    "agents",
  ],
  cacheKey: () => {
    try {
      const info = statSync(
        join(homedir(), ".local", "share", "opencode", "auth.json")
      )
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return "missing"
    }
  },
  async load(env) {
    const installation = openCodeInstallation()
    if (!installation) throw new Error("OpenCode is not installed")
    const output = await runDiscovery(
      installation.command,
      installation.generation === "v2"
        ? ["models"]
        : ["models", "--verbose"],
      env
    )
    const rows =
      installation.generation === "v2"
        ? await v2Models(output)
        : parseModels(output)
    const catalog = normalizeOpenCodeModels(rows)
    const configured = await configuredModel()
    if (configured && catalog.models.some((model) => model.id === configured)) {
      catalog.configuredModel = configured
      catalog.defaultModel = configured
    } else {
      catalog.defaultModel = preferredOpenCodeDefault(catalog.models)
    }
    return availableProviderProfile(openCodeProfileLoader, catalog)
  },
}

async function v2Models(output: string): Promise<OpenCodeModelRow[]> {
  let cached: z.infer<typeof CacheSchema> = {}
  try {
    const parsed = CacheSchema.safeParse(
      JSON.parse(
        await readFile(
          join(homedir(), ".cache", "opencode", "models.json"),
          "utf8"
        )
      )
    )
    if (parsed.success) cached = parsed.data
  } catch {
    cached = {}
  }

  return output.split(/\r?\n/).flatMap((line): OpenCodeModelRow[] => {
    const identity = line.trim()
    const separator = identity.indexOf("/")
    if (separator <= 0) return []
    const providerID = identity.slice(0, separator)
    const id = identity.slice(separator + 1)
    const cachedProvider = CacheProviderSchema.safeParse(cached[providerID])
    const cachedModel = CacheModelSchema.safeParse(
      cachedProvider.success ? cachedProvider.data.models[id] : undefined
    )
    const baseId = id.endsWith("-fast") ? id.slice(0, -5) : id
    const cachedBase = CacheModelSchema.safeParse(
      cachedProvider.success ? cachedProvider.data.models[baseId] : undefined
    )
    const model = cachedModel.success
      ? cachedModel.data
      : cachedBase.success
        ? cachedBase.data
        : undefined
    const name = model && baseId !== id ? `${model.name} Fast` : model?.name
    const reasoning = Array.isArray(model?.reasoning_options)
      ? model.reasoning_options.flatMap((option) => option.values)
      : Object.keys(model?.reasoning_options ?? {})
    return [
      {
        providerID,
        id,
        name,
        family: model?.family,
        status: model?.status,
        variants:
          reasoning.length > 0
            ? Object.fromEntries(reasoning.map((value) => [value, {}]))
            : undefined,
        limit: model?.limit,
        capabilities: {
          reasoning: model?.reasoning,
          input: { text: true, image: model?.attachment },
        },
      },
    ]
  })
}

function parseModels(output: string): OpenCodeModelRow[] {
  const rows: OpenCodeModelRow[] = []
  let start = output.indexOf("{")
  while (start >= 0) {
    let depth = 0
    let quoted = false
    let escaped = false
    let end = start
    for (; end < output.length; end += 1) {
      const character = output[end]!
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\" && quoted) {
        escaped = true
        continue
      }
      if (character === '"') quoted = !quoted
      if (quoted) continue
      if (character === "{") depth += 1
      if (character === "}") depth -= 1
      if (depth === 0) {
        end += 1
        break
      }
    }
    try {
      const parsed = ModelSchema.safeParse(JSON.parse(output.slice(start, end)))
      if (parsed.success) rows.push(parsed.data)
    } catch {
      return rows
    }
    start = output.indexOf("{", end)
  }
  return rows
}

async function configuredModel(): Promise<string | undefined> {
  for (const path of [
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".opencode", "config.json"),
  ]) {
    try {
      const parsed = ConfigSchema.safeParse(JSON.parse(await readFile(path, "utf8")))
      if (parsed.success && parsed.data.model) return parsed.data.model
    } catch {
      continue
    }
  }
  return undefined
}
