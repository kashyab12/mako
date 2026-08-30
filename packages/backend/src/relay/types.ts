import { z } from "zod"

export const RelayHarnessSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
export type RelayHarness = z.infer<typeof RelayHarnessSchema>

export const RemoteOriginSchema = z.object({
  provider: z.string().min(1).max(40),
  tenantId: z.string().min(1).max(80),
  conversationId: z.string().min(1).max(160),
  threadId: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  userId: z.string().min(1).max(80),
})
export type RemoteOrigin = z.infer<typeof RemoteOriginSchema>

export const RemoteAttachmentSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["audio", "file", "image", "video"]),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).optional(),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
})
export type RemoteAttachment = z.infer<typeof RemoteAttachmentSchema>

const RuntimeSelectionSchema = z.object({
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
  harness: RelayHarnessSchema.optional(),
  model: z.string().min(1).max(160).optional(),
})

const PromptFields = {
  attachments: z.array(RemoteAttachmentSchema).max(20).default([]),
  text: z.string().max(20_000),
}

export const RelayJobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("resume"),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
    threadPath: z.string().min(1).max(4_000),
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("resume-query"),
    origin: RemoteOriginSchema,
    query: z.string().min(1).max(500),
    selection: RuntimeSelectionSchema,
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("inspect-threads"),
    origin: RemoteOriginSchema,
    query: z.string().max(500).optional(),
    selection: RuntimeSelectionSchema,
  }),
  z.object({
    kind: z.literal("inspect-models"),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
  }),
  z.object({
    kind: z.literal("configure"),
    origin: RemoteOriginSchema,
    selection: RuntimeSelectionSchema,
    threadPath: z.string().min(1).max(4_000),
  }),
])

export type RelayJobPayload = z.infer<typeof RelayJobPayloadSchema>

export const WorkerHeartbeatSchema = z.object({
  defaultHarness: RelayHarnessSchema,
  defaultModel: z.string().min(1).max(160).optional(),
  deviceId: z.uuid(),
  deviceName: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
})

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>

export const RelayLeaseRequestSchema = WorkerHeartbeatSchema.extend({
  visibilityTimeoutSeconds: z.number().int().min(30).max(300).default(120),
})

export const RelayRenewalSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
  messageId: z.string().min(1),
  popReceipt: z.string().min(1),
  visibilityTimeoutSeconds: z.number().int().min(30).max(300).default(120),
})

export const RelayLeaseSchema = z.object({
  jobId: z.uuid(),
  messageId: z.string().min(1),
  payload: RelayJobPayloadSchema,
  popReceipt: z.string().min(1),
})

export type RelayLease = z.infer<typeof RelayLeaseSchema>

export const RelayProgressSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
  sequence: z.number().int().positive(),
  text: z.string().min(1).max(11_000),
})
export type RelayProgress = z.infer<typeof RelayProgressSchema>

export const RelayControlPollSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
})

export const RelayCompletionSchema = z.object({
  deviceId: z.uuid(),
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
  harness: RelayHarnessSchema,
  jobId: z.uuid(),
  messageId: z.string().min(1),
  model: z.string().min(1).max(160).optional(),
  popReceipt: z.string().min(1),
  result: z.string().min(1).max(1_000_000),
  status: z.enum(["done", "failed", "stopped"]).default("done"),
  threadPath: z.string().min(1).max(4_000).optional(),
})

export type RelayCompletion = z.infer<typeof RelayCompletionSchema>
