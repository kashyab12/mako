import { homedir } from "node:os"
import { join } from "node:path"
import {
  normalizeCursorModels,
  type CursorConfig,
} from "@mako/sessions/model-catalog"
import { z } from "zod"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"
import { readJson, rpcRequest } from "../profile-transport.js"

const ChoiceSchema = z.object({
  value: z.string().optional(),
  name: z.string().optional(),
  description: z.string().nullish(),
})
const ChoicesSchema = z.array(
  z.union([
    z.object({
      group: z.string().optional(),
      name: z.string().optional(),
      options: z.array(ChoiceSchema),
    }),
    ChoiceSchema,
  ])
)
const ModelsSchema = z.object({
  models: z.array(
    z.object({
      value: z.string(),
      name: z.string().optional(),
      configOptions: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
            category: z.string().nullish(),
            type: z.string().optional(),
            currentValue: z.union([z.string(), z.boolean()]).optional(),
            options: z
              .union([ChoicesSchema, z.record(z.string(), ChoicesSchema)])
              .optional(),
          })
        )
        .optional(),
    })
  ),
})

export const cursorProfileLoader: ProviderProfileLoader = {
  provider: "cursor",
  label: "Cursor",
  transport: "acp",
  capabilities: [
    "start",
    "resume-acp",
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
    const result = await rpcRequest(
      "cursor-agent",
      ["acp"],
      "cursor/list_available_models",
      env,
      true,
      {},
      cwd
    )
    const configured = await readJson<CursorConfig>(
      join(homedir(), ".cursor", "cli-config.json")
    )
    return availableProviderProfile(
      cursorProfileLoader,
      normalizeCursorModels(
        ModelsSchema.parse(result),
        configured?.model?.modelId
      )
    )
  },
}
