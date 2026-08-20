import { z } from "zod"

const OptionalStringSchema = z
  .union([z.literal("").transform(() => undefined), z.string().min(1)])
  .optional()

const ServerEnvSchema = z.object({
  MAKO_MCP_TOKEN: z.string().min(32),
  SLACK_CONNECTOR: OptionalStringSchema,
  VERCEL_ENV: z
    .union([
      z.literal("").transform(() => undefined),
      z.enum(["development", "preview", "production"]),
    ])
    .optional(),
  VERCEL_GIT_COMMIT_SHA: OptionalStringSchema,
})

const OptionalServerEnvSchema = ServerEnvSchema.extend({
  MAKO_MCP_TOKEN: z
    .union([z.literal("").transform(() => undefined), z.string().min(32)])
    .optional(),
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>

export function readServerEnv(
  environment: NodeJS.ProcessEnv = process.env
): ServerEnv {
  return ServerEnvSchema.parse(environment)
}

export function readOptionalServerEnv(
  environment: NodeJS.ProcessEnv = process.env
): Partial<ServerEnv> {
  return OptionalServerEnvSchema.parse(environment)
}
