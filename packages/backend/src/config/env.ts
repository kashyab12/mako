import { z } from "zod"

const OptionalStringSchema = z
  .union([z.literal("").transform(() => undefined), z.string().min(1)])
  .optional()

const OptionalAzureSecretSchema = z
  .union([z.literal("").transform(() => undefined), z.string().min(32)])
  .optional()

const OptionalSecretSchema = z
  .union([z.literal("").transform(() => undefined), z.string().min(64)])
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

const OptionalSlackBotTokenSchema = z
  .union([
    z.literal("").transform(() => undefined),
    z.string().min(10).max(512).regex(/^xoxb-\S+$/),
  ])
  .optional()

const OptionalSlackSigningSecretSchema = z
  .union([
    z.literal("").transform(() => undefined),
    z.string().regex(/^[a-f\d]{32}$/i),
  ])
  .optional()

const ServerEnvBaseSchema = z.object({
  AZURE_CLIENT_ID: OptionalUuidSchema,
  AZURE_CLIENT_SECRET: OptionalAzureSecretSchema,
  AZURE_STORAGE_ACCOUNT_NAME: OptionalStorageAccountSchema,
  AZURE_TENANT_ID: OptionalUuidSchema,
  MAKO_MCP_TOKEN: z.string().min(32),
  RELAY_ALLOW_LEGACY_TOKEN: z
    .union([z.literal("true"), z.literal("false")])
    .optional(),
  RELAY_BOOTSTRAP_SECRET: OptionalSecretSchema,
  RELAY_TOKEN_SECRET: OptionalSecretSchema,
  SLACK_ALLOWED_USER_IDS: OptionalStringSchema,
  SLACK_BOT_TOKEN: OptionalSlackBotTokenSchema,
  SLACK_CONNECTOR: OptionalStringSchema,
  SLACK_SIGNING_SECRET: OptionalSlackSigningSecretSchema,
  SLACK_TEAM_ID: OptionalStringSchema,
  VERCEL_ENV: z
    .union([
      z.literal("").transform(() => undefined),
      z.enum(["development", "preview", "production"]),
    ])
    .optional(),
  VERCEL_GIT_COMMIT_SHA: OptionalStringSchema,
})

function requireSlackCredentialPair(
  environment: {
    SLACK_BOT_TOKEN?: string
    SLACK_SIGNING_SECRET?: string
  },
  context: z.RefinementCtx
): void {
  if (Boolean(environment.SLACK_BOT_TOKEN) === Boolean(environment.SLACK_SIGNING_SECRET)) {
    return
  }
  context.addIssue({
    code: "custom",
    message: "SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET must be configured together",
    path: ["SLACK_BOT_TOKEN"],
  })
}

const ServerEnvSchema = ServerEnvBaseSchema.superRefine(requireSlackCredentialPair)

const OptionalServerEnvSchema = ServerEnvBaseSchema.extend({
  MAKO_MCP_TOKEN: z
    .union([z.literal("").transform(() => undefined), z.string().min(32)])
    .optional(),
}).superRefine(requireSlackCredentialPair)

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
