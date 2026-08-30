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

export const LegacySlackOriginSchema = z.object({
  channel: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  teamId: z.string().min(1).max(80),
  threadTs: z.string().min(1).max(160),
  userId: z.string().min(1).max(80),
})

export const RemoteAttachmentSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["audio", "file", "image", "video"]),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).optional(),
  size: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
})
export type RemoteAttachment = z.infer<typeof RemoteAttachmentSchema>

export const RuntimeSelectionSchema = z.object({
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
  harness: RelayHarnessSchema.optional(),
  model: z.string().min(1).max(160).optional(),
})
export type RuntimeSelection = z.infer<typeof RuntimeSelectionSchema>

const OriginFields = {
  origin: RemoteOriginSchema,
  slack: LegacySlackOriginSchema.optional(),
}

const PromptFields = {
  attachments: z.array(RemoteAttachmentSchema).max(20).default([]),
  text: z.string().max(20_000),
}

export const RelayJobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    forceNew: z.boolean().default(false),
    ...OriginFields,
    selection: RuntimeSelectionSchema,
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("resume"),
    ...OriginFields,
    selection: RuntimeSelectionSchema,
    threadPath: z.string().min(1).max(4_000),
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("resume-query"),
    ...OriginFields,
    query: z.string().min(1).max(500),
    selection: RuntimeSelectionSchema,
    ...PromptFields,
  }),
  z.object({
    kind: z.literal("inspect-threads"),
    ...OriginFields,
    query: z.string().max(500).optional(),
    selection: RuntimeSelectionSchema,
  }),
  z.object({
    kind: z.literal("inspect-models"),
    ...OriginFields,
    selection: RuntimeSelectionSchema,
  }),
  z.object({
    kind: z.literal("configure"),
    ...OriginFields,
    selection: RuntimeSelectionSchema,
    threadPath: z.string().min(1).max(4_000),
  }),
])
export type RelayJobPayload = z.infer<typeof RelayJobPayloadSchema>

export function parseRelayJobPayload<Value>(value: Value): RelayJobPayload {
  const current = RelayJobPayloadSchema.safeParse(value)
  if (current.success) return current.data
  const record = z.record(z.string(), z.json()).parse(value)
  const slack = LegacySlackOriginSchema.parse(record.slack)
  return RelayJobPayloadSchema.parse({
    ...record,
    attachments: record.attachments ?? [],
    origin: {
      provider: "slack",
      tenantId: slack.teamId,
      conversationId: slack.channel,
      threadId: slack.threadTs,
      eventId: slack.eventId,
      userId: slack.userId,
    },
  })
}

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
export type RelayLeaseRequest = z.infer<typeof RelayLeaseRequestSchema>

export const RelayRenewalSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
  messageId: z.string().min(1),
  popReceipt: z.string().min(1),
  visibilityTimeoutSeconds: z.number().int().min(30).max(300).default(120),
})
export type RelayRenewal = z.infer<typeof RelayRenewalSchema>

export const RelayLeaseSchema = z.object({
  jobId: z.uuid(),
  messageId: z.string().min(1),
  payload: RelayJobPayloadSchema,
  popReceipt: z.string().min(1),
})
export type RelayLease = z.infer<typeof RelayLeaseSchema>

export const RelayLegacyProgressSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
  sequence: z.number().int().positive(),
  text: z.string().min(1).max(11_000),
})
export type RelayLegacyProgress = z.infer<typeof RelayLegacyProgressSchema>

export const RelayControlPollSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
})
export type RelayControlPoll = z.infer<typeof RelayControlPollSchema>

export const RelayCompletionSchema = z.object({
  deviceId: z.uuid(),
  effort: z.string().min(1).max(80).optional(),
  fast: z.boolean().optional(),
  harness: RelayHarnessSchema,
  jobId: z.uuid(),
  messageId: z.string().min(1),
  model: z.string().min(1).max(160).optional(),
  popReceipt: z.string().min(1),
  progressFailed: z.boolean().default(false),
  result: z.string().min(1).max(1_000_000),
  status: z.enum(["done", "failed", "stopped"]).default("done"),
  threadPath: z.string().min(1).max(4_000).optional(),
})
export type RelayCompletion = z.infer<typeof RelayCompletionSchema>

export const RelayCursorSchema = z.object({
  epoch: z.uuid(),
  seq: z.number().int().nonnegative(),
})
export type RelayCursor = z.infer<typeof RelayCursorSchema>

const RelayPlanEntrySchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(256),
  status: z.enum(["pending", "in_progress", "completed", "failed", "canceled"]),
})

const RelayPermissionOptionSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(256),
  kind: z.string().max(80).optional(),
})

export const RelayCanonicalEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(32_000) }),
  z.object({
    kind: z.literal("reasoning"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256).default("Reasoning"),
    status: z.enum(["in_progress", "completed"]),
    detail: z.string().max(2_000).optional(),
  }),
  z.object({
    kind: z.literal("tool"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256),
    status: z.enum(["pending", "in_progress", "completed", "failed", "canceled"]),
    detail: z.string().max(2_000).optional(),
    output: z.string().max(4_000).optional(),
  }),
  z.object({
    kind: z.literal("plan"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256),
    entries: z.array(RelayPlanEntrySchema).max(100),
  }),
  z.object({
    kind: z.literal("permission"),
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256),
    options: z.array(RelayPermissionOptionSchema).max(20),
  }),
  z.object({
    kind: z.literal("lifecycle"),
    status: z.enum(["queued", "starting", "running", "suspended", "completed", "failed", "stopped"]),
    detail: z.string().max(2_000).optional(),
  }),
])
export type RelayCanonicalEvent = z.infer<typeof RelayCanonicalEventSchema>

export const RelayEventEnvelopeSchema = z.object({
  version: z.literal(1),
  eventId: z.uuid(),
  jobId: z.uuid(),
  workerId: z.uuid(),
  cursor: RelayCursorSchema,
  jobSeq: z.number().int().positive(),
  at: z.iso.datetime(),
  event: RelayCanonicalEventSchema,
})
export type RelayEventEnvelope = z.infer<typeof RelayEventEnvelopeSchema>

export const RelayEventBatchSchema = z.object({
  deviceId: z.uuid(),
  jobId: z.uuid(),
  cursor: RelayCursorSchema.optional(),
  events: z.array(RelayEventEnvelopeSchema).min(1).max(100),
})
export type RelayEventBatch = z.infer<typeof RelayEventBatchSchema>

export const RelayRegistrationSchema = z.object({
  tenantId: z.string().min(1).max(80),
  deviceId: z.uuid(),
  deviceName: z.string().min(1).max(160),
  defaultHarness: RelayHarnessSchema,
  defaultModel: z.string().min(1).max(160).optional(),
})
export type RelayRegistration = z.infer<typeof RelayRegistrationSchema>

export const RelayTokenClaimsSchema = z.object({
  version: z.literal(1),
  tenantId: z.string().min(1).max(80),
  deviceId: z.uuid(),
  scopes: z.array(z.enum(["relay:read", "relay:write"])).min(1),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
})
export type RelayTokenClaims = z.infer<typeof RelayTokenClaimsSchema>
