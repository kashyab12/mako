import { z } from "zod"

const OptionalStringSchema = z
  .union([z.literal("").transform(() => undefined), z.string().min(1)])
  .optional()

const OptionalUuidSchema = z
  .union([z.literal("").transform(() => undefined), z.uuid()])
  .optional()

const OptionalStorageAccountSchema = z
  .union([
    z.literal("").transform(() => undefined),
    z.string().regex(/^[a-z0-9]{3,24}$/),
  ])
  .optional()

const ServerEnvSchema = z.object({
  AZURE_CLIENT_ID: OptionalUuidSchema,
  AZURE_CLIENT_SECRET: OptionalStringSchema,
  AZURE_STORAGE_ACCOUNT_NAME: OptionalStorageAccountSchema,
  AZURE_TENANT_ID: OptionalUuidSchema,
  MAKO_MCP_TOKEN: z.string().min(32),
  SLACK_ALLOWED_USER_IDS: OptionalStringSchema,
  SLACK_CONNECTOR: OptionalStringSchema,
  SLACK_TEAM_ID: OptionalStringSchema,
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

const RelayEnvSchema = z.object({
  AZURE_CLIENT_ID: z.uuid(),
  AZURE_CLIENT_SECRET: z.string().min(32),
  AZURE_STORAGE_ACCOUNT_NAME: z.string().regex(/^[a-z0-9]{3,24}$/),
  AZURE_TENANT_ID: z.uuid(),
})

export type ServerEnv = z.infer<typeof ServerEnvSchema>
export type RelayEnv = z.infer<typeof RelayEnvSchema>

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

export function readRelayEnv(
  environment: NodeJS.ProcessEnv = process.env
): RelayEnv {
  return RelayEnvSchema.parse(environment)
}
