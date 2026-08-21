import { createHash } from "node:crypto"
import { ClientSecretCredential } from "@azure/identity"
import { QueueClient } from "@azure/storage-queue"
import { TableClient, type TableEntity } from "@azure/data-tables"
import { z } from "zod"
import { readRelayEnv } from "../config/env"
import {
  RelayCompletionSchema,
  RelayJobPayloadSchema,
  RelayLeaseSchema,
  type RelayCompletion,
  type RelayJobPayload,
  type RelayLease,
  type WorkerHeartbeat,
} from "./types"

interface RelayJobEntity extends TableEntity {
  createdAt: string
  resultEffort?: string
  resultFast?: boolean
  payload: string
  result?: string
  resultHarness?: string
  resultModel?: string
  status: "queued" | "claimed" | "completed" | "delivered" | "failed"
  threadPath?: string
  updatedAt: string
  workerId?: string
}

interface RelayThreadEntity extends TableEntity {
  deviceId: string
  effort?: string
  fast?: boolean
  harness: string
  model?: string
  threadPath: string
  updatedAt: string
}

interface RelayWorkerEntity extends TableEntity {
  defaultHarness: string
  defaultModel?: string
  deviceName: string
  lastSeenAt: string
  version: string
}

const AzureErrorSchema = z.object({ statusCode: z.number().int() }).passthrough()

let clients:
  | {
      jobs: TableClient
      queue: QueueClient
      threads: TableClient
      workers: TableClient
    }
  | undefined

function relayClients() {
  if (clients) return clients
  const environment = readRelayEnv()
  const credential = new ClientSecretCredential(
    environment.AZURE_TENANT_ID,
    environment.AZURE_CLIENT_ID,
    environment.AZURE_CLIENT_SECRET
  )
  const account = environment.AZURE_STORAGE_ACCOUNT_NAME
  clients = {
    jobs: new TableClient(
      `https://${account}.table.core.windows.net`,
      "MakoJobs",
      credential
    ),
    queue: new QueueClient(
      `https://${account}.queue.core.windows.net/mako-jobs`,
      credential
    ),
    threads: new TableClient(
      `https://${account}.table.core.windows.net`,
      "MakoThreads",
      credential
    ),
    workers: new TableClient(
      `https://${account}.table.core.windows.net`,
      "MakoWorkers",
      credential
    ),
  }
  return clients
}

function statusCode(error: Error): number | undefined {
  const parsed = AzureErrorSchema.safeParse(error)
  return parsed.success ? parsed.data.statusCode : undefined
}

function deterministicJobId(eventId: string): string {
  const value = createHash("sha256").update(eventId).digest("hex").slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`
}

function threadPartition(payload: RelayJobPayload): string {
  return `slack:${payload.slack.teamId}:${payload.slack.channel}`
}

export async function enqueueRelayJob(payload: RelayJobPayload): Promise<{
  created: boolean
  jobId: string
}> {
  const parsed = RelayJobPayloadSchema.parse(payload)
  const jobId = deterministicJobId(parsed.slack.eventId)
  const now = new Date().toISOString()
  const entity: RelayJobEntity = {
    partitionKey: "jobs",
    rowKey: jobId,
    createdAt: now,
    payload: JSON.stringify(parsed),
    status: "queued",
    updatedAt: now,
  }
  try {
    await relayClients().jobs.createEntity(entity)
  } catch (error) {
    if (error instanceof Error && statusCode(error) === 409) {
      return { created: false, jobId }
    }
    throw error
  }
  await relayClients().queue.sendMessage(jobId, { messageTimeToLive: -1 })
  return { created: true, jobId }
}

export async function heartbeatWorker({
  heartbeat,
  teamId,
}: {
  heartbeat: WorkerHeartbeat
  teamId: string
}): Promise<void> {
  const entity: RelayWorkerEntity = {
    partitionKey: `workers:${teamId}`,
    rowKey: heartbeat.deviceId,
    defaultHarness: heartbeat.defaultHarness,
    defaultModel: heartbeat.defaultModel,
    deviceName: heartbeat.deviceName,
    lastSeenAt: new Date().toISOString(),
    version: heartbeat.version,
  }
  await relayClients().workers.upsertEntity(entity, "Replace")
}

export async function activeWorker(teamId: string): Promise<RelayWorkerEntity | null> {
  const cutoff = Date.now() - 45_000
  let newest: RelayWorkerEntity | null = null
  for await (const worker of relayClients().workers.listEntities<RelayWorkerEntity>({
    queryOptions: { filter: `PartitionKey eq 'workers:${teamId}'` },
  })) {
    if (Date.parse(worker.lastSeenAt) < cutoff) continue
    if (!newest || worker.lastSeenAt > newest.lastSeenAt) newest = worker
  }
  return newest
}

export type LeaseResult =
  | { kind: "empty" }
  | {
      kind: "completed"
      completion: RelayCompletion
      lease: Pick<RelayLease, "messageId" | "popReceipt">
      payload: RelayJobPayload
    }
  | { kind: "work"; lease: RelayLease }

export async function leaseRelayJob({
  deviceId,
  visibilityTimeoutSeconds,
}: {
  deviceId: string
  visibilityTimeoutSeconds: number
}): Promise<LeaseResult> {
  const response = await relayClients().queue.receiveMessages({
    numberOfMessages: 1,
    visibilityTimeout: visibilityTimeoutSeconds,
  })
  const message = response.receivedMessageItems[0]
  if (!message) return { kind: "empty" }
  const jobId = z.uuid().parse(message.messageText)
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  const payload = RelayJobPayloadSchema.parse(JSON.parse(entity.payload))
  if (
    entity.status === "completed" &&
    entity.result &&
    entity.resultHarness
  ) {
    return {
      kind: "completed",
      completion: RelayCompletionSchema.parse({
        deviceId: entity.workerId ?? deviceId,
        effort: entity.resultEffort,
        fast: entity.resultFast,
        harness: entity.resultHarness,
        jobId,
        messageId: message.messageId,
        model: entity.resultModel,
        popReceipt: message.popReceipt,
        result: entity.result,
        threadPath: entity.threadPath,
      }),
      lease: {
        messageId: message.messageId,
        popReceipt: message.popReceipt,
      },
      payload,
    }
  }
  if (entity.status === "delivered") {
    await relayClients().queue.deleteMessage(message.messageId, message.popReceipt)
    return { kind: "empty" }
  }
  const updated: RelayJobEntity = {
    ...entity,
    status: "claimed",
    updatedAt: new Date().toISOString(),
    workerId: deviceId,
  }
  await relayClients().jobs.updateEntity(updated, "Replace", {
    etag: entity.etag,
  })
  return {
    kind: "work",
    lease: RelayLeaseSchema.parse({
      jobId,
      messageId: message.messageId,
      payload,
      popReceipt: message.popReceipt,
    }),
  }
}

export async function renewRelayLease({
  deviceId,
  jobId,
  messageId,
  popReceipt,
  visibilityTimeoutSeconds,
}: {
  deviceId: string
  jobId: string
  messageId: string
  popReceipt: string
  visibilityTimeoutSeconds: number
}): Promise<string> {
  const job = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  if (job.workerId !== deviceId || job.status !== "claimed") {
    throw new Error("Relay lease is not owned by this device")
  }
  const updated = await relayClients().queue.updateMessage(
    messageId,
    popReceipt,
    jobId,
    visibilityTimeoutSeconds
  )
  return z.string().min(1).parse(updated.popReceipt)
}

export async function recordRelayCompletion(
  completion: RelayCompletion
): Promise<RelayJobPayload> {
  const parsed = RelayCompletionSchema.parse(completion)
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>(
    "jobs",
    parsed.jobId
  )
  const payload = RelayJobPayloadSchema.parse(JSON.parse(entity.payload))
  if (entity.status === "completed" && entity.workerId === parsed.deviceId) {
    return payload
  }
  if (entity.status !== "claimed" || entity.workerId !== parsed.deviceId) {
    throw new Error("Relay job is not claimed by this device")
  }
  const updated: RelayJobEntity = {
    ...entity,
    result: parsed.result,
    resultEffort: parsed.effort,
    resultFast: parsed.fast,
    resultHarness: parsed.harness,
    resultModel: parsed.model,
    status: "completed",
    threadPath: parsed.threadPath,
    updatedAt: new Date().toISOString(),
    workerId: parsed.deviceId,
  }
  await relayClients().jobs.updateEntity(updated, "Replace", {
    etag: entity.etag,
  })
  return payload
}

export async function markRelayDelivered({
  completion,
  payload,
}: {
  completion: RelayCompletion
  payload: RelayJobPayload
}): Promise<void> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>(
    "jobs",
    completion.jobId
  )
  if (entity.status === "delivered") return
  if (entity.status !== "completed" || entity.workerId !== completion.deviceId) {
    throw new Error("Relay result is not ready for delivery")
  }
  if (completion.threadPath) {
    const mapping: RelayThreadEntity = {
      partitionKey: threadPartition(payload),
      rowKey: payload.slack.threadTs,
      deviceId: completion.deviceId,
      effort: completion.effort,
      fast: completion.fast,
      harness: completion.harness,
      model: completion.model,
      threadPath: completion.threadPath,
      updatedAt: new Date().toISOString(),
    }
    await relayClients().threads.upsertEntity(mapping, "Replace")
  }
  await relayClients().jobs.updateEntity(
    {
      ...entity,
      status: "delivered",
      updatedAt: new Date().toISOString(),
    },
    "Replace",
    { etag: entity.etag }
  )
  await relayClients().queue.deleteMessage(
    completion.messageId,
    completion.popReceipt
  )
}

export async function readThreadMapping({
  channel,
  teamId,
  threadTs,
}: {
  channel: string
  teamId: string
  threadTs: string
}): Promise<RelayThreadEntity | null> {
  try {
    return await relayClients().threads.getEntity<RelayThreadEntity>(
      `slack:${teamId}:${channel}`,
      threadTs
    )
  } catch (error) {
    if (error instanceof Error && statusCode(error) === 404) return null
    throw error
  }
}
