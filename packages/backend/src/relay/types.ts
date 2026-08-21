import { z } from "zod"
import {
  SlackChannelIdSchema,
  SlackTimestampSchema,
} from "../integrations/slack/client"

export const RelayHarnessSchema = z.enum(["claude", "codex", "cursor", "grok"])
export type RelayHarness = z.infer<typeof RelayHarnessSchema>

const SlackContextSchema = z.object({
  channel: SlackChannelIdSchema,
  eventId: z.string().min(1).max(160),
  teamId: z.string().min(1).max(80),
  threadTs: SlackTimestampSchema,
  userId: z.string().min(1).max(80),
})

const RuntimeSelectionSchema = z.object({
  harness: RelayHarnessSchema.optional(),
  model: z.string().min(1).max(160).optional(),
})

export const RelayJobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    selection: RuntimeSelectionSchema,
    slack: SlackContextSchema,
    text: z.string().min(1).max(20_000),
  }),
  z.object({
    kind: z.literal("resume"),
    selection: RuntimeSelectionSchema,
    slack: SlackContextSchema,
    text: z.string().min(1).max(20_000),
    threadPath: z.string().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal("resume-query"),
    query: z.string().min(1).max(500),
    selection: RuntimeSelectionSchema,
    slack: SlackContextSchema,
    text: z.string().min(1).max(20_000),
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

export const RelayCompletionSchema = z.object({
  deviceId: z.uuid(),
  harness: RelayHarnessSchema,
  jobId: z.uuid(),
  messageId: z.string().min(1),
  model: z.string().min(1).max(160).optional(),
  popReceipt: z.string().min(1),
  result: z.string().min(1).max(1_000_000),
  threadPath: z.string().min(1).max(4_000).optional(),
})

export type RelayCompletion = z.infer<typeof RelayCompletionSchema>
