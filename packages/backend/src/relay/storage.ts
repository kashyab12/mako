import { createHash, randomBytes } from "node:crypto"
import { ClientSecretCredential } from "@azure/identity"
import { QueueClient } from "@azure/storage-queue"
import { TableClient, type TableEntity } from "@azure/data-tables"
import {
  RelayEventEnvelopeSchema,
  relayDeviceKey,
  relayEventsAfter,
  type RelayEventBatch,
  type RelayEventEnvelope,
} from "@mako/relay"
import { z } from "zod"
import { readRelayEnv } from "../config/env"
import {
  RelayCompletionSchema,
  RelayHarnessSchema,
  RelayJobPayloadSchema,
  RelayLeaseSchema,
  parseRelayJobPayload,
  type RelayCompletion,
  type RelayJobPayload,
  type RelayLease,
  type RelayProgress,
  type RemoteAttachment,
  type RemoteOrigin,
  type WorkerHeartbeat,
} from "./types"

interface RelayEventEntity extends TableEntity {
  data: string
  epoch: string
  seq: number
}

interface RelayJobEntity extends TableEntity {
  createdAt: string
  resultEffort?: string
  resultFast?: boolean
  payload: string
  result?: string
  resultHarness?: string
  resultModel?: string
  resultProgressFailed?: boolean
  resultStatus?: string
  status: "pending" | "queued" | "claimed" | "completed" | "delivered" | "failed"
  queueConfirmed?: boolean
  pendingDeleteMessageId?: string
  pendingDeletePopReceipt?: string
  threadPath?: string
  targetDeviceId?: string
  streamTs?: string
  streamClosed?: boolean
  streamedChars?: number
  lastProgressSequence?: number
  deliveredEventEpoch?: string
  deliveredEventSeq?: number
  control?: "stop"
  uploadedArtifactKeys?: string
  originProvider: string
  originTenantId: string
  originConversationId: string
  originThreadId: string
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

interface RelayRegistrationEntity extends TableEntity {
  deviceKey: string
  deviceName: string
  registeredAt: string
}

interface RelayWorkerEntity extends TableEntity {
  defaultHarness: string
  defaultModel?: string
  deviceName: string
  lastSeenAt: string
  version: string
}

const AzureErrorSchema = z.object({ statusCode: z.number().int() }).passthrough()
const UploadedArtifactKeysSchema = z.array(z.string().min(1).max(128)).max(20)

let clients:
  | {
      events: TableClient
      jobs: TableClient
      queue: QueueClient
      registrations: TableClient
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
    events: new TableClient(
      `https://${account}.table.core.windows.net`,
      "MakoEvents",
      credential
    ),
    jobs: new TableClient(
      `https://${account}.table.core.windows.net`,
      "MakoJobs",
      credential
    ),
    queue: new QueueClient(
      `https://${account}.queue.core.windows.net/mako-jobs`,
      credential
    ),
    registrations: new TableClient(
      `https://${account}.table.core.windows.net`,
      "MakoRegistrations",
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

export async function registerRelayDevice({
  tenantId,
  deviceId,
  deviceName,
}: {
  tenantId: string
  deviceId: string
  deviceName: string
}): Promise<string> {
  const deviceSecret = randomBytes(48).toString("base64url")
  const entity: RelayRegistrationEntity = {
    partitionKey: `registrations:${tenantId}`,
    rowKey: deviceId,
    deviceKey: relayDeviceKey(deviceSecret).toString("base64url"),
    deviceName,
    registeredAt: new Date().toISOString(),
  }
  await relayClients().registrations.createEntity(entity)
  return deviceSecret
}

export async function relayDeviceKeyFor(
  tenantId: string,
  deviceId: string
): Promise<Buffer | null> {
  try {
    const entity = await relayClients().registrations.getEntity<RelayRegistrationEntity>(
      `registrations:${tenantId}`,
      deviceId
    )
    return Buffer.from(entity.deviceKey, "base64url")
  } catch (error) {
    if (error instanceof Error && statusCode(error) === 404) return null
    throw error
  }
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
  const { provider, tenantId, conversationId } = payload.origin
  return `${provider}:${tenantId}:${conversationId}`
}

function originFilter(origin: RemoteOrigin): string {
  return [
    "PartitionKey eq 'jobs'",
    `originProvider eq '${escapeFilter(origin.provider)}'`,
    `originTenantId eq '${escapeFilter(origin.tenantId)}'`,
    `originConversationId eq '${escapeFilter(origin.conversationId)}'`,
    `originThreadId eq '${escapeFilter(origin.threadId)}'`,
  ].join(" and ")
}

async function anotherJobIsRunning(
  origin: RemoteOrigin,
  jobId: string
): Promise<boolean> {
  const filter = `${originFilter(origin)} and status eq 'claimed'`
  for await (const entity of relayClients().jobs.listEntities<RelayJobEntity>({
    queryOptions: { filter },
  })) {
    if (entity.rowKey !== jobId) return true
  }
  return false
}

export function applyRelayThreadMapping(
  payload: RelayJobPayload,
  mapping: Pick<
    RelayThreadEntity,
    "effort" | "fast" | "harness" | "model" | "threadPath"
  > | null
): RelayJobPayload {
  if (payload.kind !== "new" || payload.forceNew || !mapping) return payload
  return {
    kind: "resume",
    attachments: payload.attachments,
    origin: payload.origin,
    selection: {
      effort: payload.selection.effort ?? mapping.effort,
      fast: payload.selection.fast ?? mapping.fast,
      harness:
        payload.selection.harness ?? RelayHarnessSchema.parse(mapping.harness),
      model: payload.selection.model ?? mapping.model,
    },
    text: payload.text,
    threadPath: mapping.threadPath,
  }
}

async function enqueueJobMessage(jobId: string): Promise<void> {
  let failure: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await relayClients().queue.sendMessage(jobId, { messageTimeToLive: -1 })
      return
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  throw failure ?? new Error("Relay queue rejected the job")
}

export async function enqueueRelayJob(
  payload: z.input<typeof RelayJobPayloadSchema>,
  targetDeviceId?: string
): Promise<{
  created: boolean
  jobId: string
}> {
  const parsed = RelayJobPayloadSchema.parse(payload)
  const jobId = deterministicJobId(parsed.origin.eventId)
  const now = new Date().toISOString()
  const entity: RelayJobEntity = {
    partitionKey: "jobs",
    rowKey: jobId,
    createdAt: now,
    originProvider: parsed.origin.provider,
    originTenantId: parsed.origin.tenantId,
    originConversationId: parsed.origin.conversationId,
    originThreadId: parsed.origin.threadId,
    payload: JSON.stringify(parsed),
    queueConfirmed: false,
    status: "pending",
    targetDeviceId,
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
  try {
    await enqueueJobMessage(jobId)
    await relayClients().jobs.updateEntity(
      {
        partitionKey: "jobs",
        rowKey: jobId,
        queueConfirmed: true,
        status: "queued",
        updatedAt: new Date().toISOString(),
      },
      "Merge"
    )
  } catch {
    return { created: true, jobId }
  }
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

export async function workerById(
  teamId: string,
  deviceId: string
): Promise<RelayWorkerEntity | null> {
  try {
    const worker = await relayClients().workers.getEntity<RelayWorkerEntity>(
      `workers:${teamId}`,
      deviceId
    )
    return Date.parse(worker.lastSeenAt) >= Date.now() - 45_000
      ? worker
      : null
  } catch (error) {
    if (error instanceof Error && statusCode(error) === 404) return null
    throw error
  }
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
  tenantId,
  deviceId,
  visibilityTimeoutSeconds,
}: {
  tenantId: string
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
  const payload = parseRelayJobPayload(JSON.parse(entity.payload))
  if (payload.origin.tenantId !== tenantId) {
    await relayClients().queue.updateMessage(
      message.messageId,
      message.popReceipt,
      jobId,
      5
    )
    return { kind: "empty" }
  }
  if (entity.targetDeviceId && entity.targetDeviceId !== deviceId) {
    await relayClients().queue.updateMessage(
      message.messageId,
      message.popReceipt,
      jobId,
      5
    )
    return { kind: "empty" }
  }
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
        progressFailed: entity.resultProgressFailed,
        result: entity.result,
        status: entity.resultStatus,
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
  if (await anotherJobIsRunning(payload.origin, jobId)) {
    await relayClients().queue.updateMessage(
      message.messageId,
      message.popReceipt,
      jobId,
      5
    )
    return { kind: "empty" }
  }
  const mapping =
    payload.kind === "new" && !payload.forceNew
      ? await readThreadMapping(payload.origin)
      : null
  const executablePayload = applyRelayThreadMapping(payload, mapping)
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
      payload: executablePayload,
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
  const payload = parseRelayJobPayload(JSON.parse(entity.payload))
  if (
    (entity.status === "completed" || entity.status === "delivered") &&
    entity.workerId === parsed.deviceId
  )
    return payload
  if (entity.status !== "claimed" || entity.workerId !== parsed.deviceId) {
    throw new Error("Relay job is not claimed by this device")
  }
  await relayClients().jobs.updateEntity(
    {
      partitionKey: "jobs",
      rowKey: parsed.jobId,
      result: parsed.result,
      resultEffort: parsed.effort,
      resultFast: parsed.fast,
      resultHarness: parsed.harness,
      resultModel: parsed.model,
      resultProgressFailed: parsed.progressFailed,
      resultStatus: parsed.status,
      status: "completed",
      threadPath: parsed.threadPath,
      updatedAt: new Date().toISOString(),
      workerId: parsed.deviceId,
    },
    "Merge",
    { etag: entity.etag }
  )
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
      rowKey: payload.origin.threadId,
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
      partitionKey: "jobs",
      rowKey: completion.jobId,
      pendingDeleteMessageId: completion.messageId,
      pendingDeletePopReceipt: completion.popReceipt,
      status: "delivered",
      updatedAt: new Date().toISOString(),
    },
    "Merge",
    { etag: entity.etag }
  )
  await relayClients().queue.deleteMessage(
    completion.messageId,
    completion.popReceipt
  )
  await relayClients().jobs.updateEntity(
    {
      partitionKey: "jobs",
      rowKey: completion.jobId,
      pendingDeleteMessageId: "",
      pendingDeletePopReceipt: "",
      updatedAt: new Date().toISOString(),
    },
    "Merge"
  )
}

export interface RelayDeliveryState {
  payload: RelayJobPayload
  status: RelayJobEntity["status"]
  streamClosed: boolean
  streamTs?: string
  streamedChars: number
}

export async function relayDeliveryState(
  jobId: string
): Promise<RelayDeliveryState> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  return {
    payload: parseRelayJobPayload(JSON.parse(entity.payload)),
    status: entity.status,
    streamClosed: entity.streamClosed ?? false,
    streamTs: entity.streamTs,
    streamedChars: entity.streamedChars ?? 0,
  }
}

export async function recordRelayStream({
  deviceId,
  jobId,
  streamTs,
}: {
  deviceId: string
  jobId: string
  streamTs: string
}): Promise<void> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  if (entity.status !== "claimed" || entity.workerId !== deviceId)
    throw new Error("Relay stream is not owned by this device")
  if (entity.streamTs) return
  await relayClients().jobs.updateEntity(
    {
      partitionKey: "jobs",
      rowKey: jobId,
      streamTs,
      streamedChars: 0,
    },
    "Merge",
    { etag: entity.etag }
  )
}

export async function recordRelayStreamClosed({
  deviceId,
  jobId,
}: {
  deviceId: string
  jobId: string
}): Promise<void> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  if (entity.workerId !== deviceId)
    throw new Error("Relay stream is not owned by this device")
  if (entity.streamClosed) return
  await relayClients().jobs.updateEntity(
    {
      partitionKey: "jobs",
      rowKey: jobId,
      streamClosed: true,
      updatedAt: new Date().toISOString(),
    },
    "Merge",
    { etag: entity.etag }
  )
}

export async function relayProgressTarget(
  progress: RelayProgress
): Promise<RelayDeliveryState & { accepted: boolean }> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>(
    "jobs",
    progress.jobId
  )
  if (entity.status !== "claimed" || entity.workerId !== progress.deviceId)
    throw new Error("Relay progress is not owned by this device")
  return {
    accepted: progress.sequence > (entity.lastProgressSequence ?? 0),
    payload: parseRelayJobPayload(JSON.parse(entity.payload)),
    status: entity.status,
    streamClosed: entity.streamClosed ?? false,
    streamTs: entity.streamTs,
    streamedChars: entity.streamedChars ?? 0,
  }
}

export async function recordRelayProgress(
  progress: RelayProgress
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entity = await relayClients().jobs.getEntity<RelayJobEntity>(
      "jobs",
      progress.jobId
    )
    if (entity.status !== "claimed" || entity.workerId !== progress.deviceId)
      throw new Error("Relay progress is not owned by this device")
    if (progress.sequence <= (entity.lastProgressSequence ?? 0)) return
    try {
      await relayClients().jobs.updateEntity(
        {
          partitionKey: "jobs",
          rowKey: progress.jobId,
          lastProgressSequence: progress.sequence,
          streamedChars: (entity.streamedChars ?? 0) + progress.text.length,
          updatedAt: new Date().toISOString(),
        },
        "Merge",
        { etag: entity.etag }
      )
      return
    } catch (error) {
      if (!(error instanceof Error) || statusCode(error) !== 412 || attempt === 2)
        throw error
    }
  }
}

function escapeFilter(value: string): string {
  return value.replaceAll("'", "''")
}

export async function relayQueueStatus(origin: RemoteOrigin): Promise<{
  queued: number
  running: number
}> {
  const filter = [
    "PartitionKey eq 'jobs'",
    `originProvider eq '${escapeFilter(origin.provider)}'`,
    `originTenantId eq '${escapeFilter(origin.tenantId)}'`,
    `originConversationId eq '${escapeFilter(origin.conversationId)}'`,
    `originThreadId eq '${escapeFilter(origin.threadId)}'`,
  ].join(" and ")
  let queued = 0
  let running = 0
  for await (const entity of relayClients().jobs.listEntities<RelayJobEntity>({
    queryOptions: { filter },
  })) {
    if (entity.status === "queued") queued += 1
    if (entity.status === "claimed") running += 1
  }
  return { queued, running }
}

async function markRelayStop(jobId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
    if (entity.status !== "claimed") return false
    try {
      await relayClients().jobs.updateEntity(
        {
          partitionKey: "jobs",
          rowKey: jobId,
          control: "stop",
          updatedAt: new Date().toISOString(),
        },
        "Merge",
        { etag: entity.etag }
      )
      return true
    } catch (error) {
      if (!(error instanceof Error) || statusCode(error) !== 412 || attempt === 2)
        throw error
    }
  }
  return false
}

export async function requestRelayStop(origin: RemoteOrigin): Promise<number> {
  const filter = [
    "PartitionKey eq 'jobs'",
    "status eq 'claimed'",
    `originProvider eq '${escapeFilter(origin.provider)}'`,
    `originTenantId eq '${escapeFilter(origin.tenantId)}'`,
    `originConversationId eq '${escapeFilter(origin.conversationId)}'`,
    `originThreadId eq '${escapeFilter(origin.threadId)}'`,
  ].join(" and ")
  let stopped = 0
  for await (const entity of relayClients().jobs.listEntities<RelayJobEntity>({
    queryOptions: { filter },
  })) {
    if (await markRelayStop(entity.rowKey)) stopped += 1
  }
  return stopped
}

export async function relayControl({
  deviceId,
  jobId,
}: {
  deviceId: string
  jobId: string
}): Promise<"stop" | null> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  if (entity.status !== "claimed" || entity.workerId !== deviceId)
    throw new Error("Relay job is not owned by this device")
  return entity.control ?? null
}

export async function relayAttachment(
  jobId: string,
  attachmentId: string,
  deviceId: string
): Promise<RemoteAttachment> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  if (entity.status !== "claimed" || entity.workerId !== deviceId)
    throw new Error("Relay attachment is not owned by this device")
  const payload = parseRelayJobPayload(JSON.parse(entity.payload))
  if (!("attachments" in payload))
    throw new Error("Relay job has no attachments")
  const attachment = payload.attachments.find(
    (candidate) => candidate.id === attachmentId
  )
  if (!attachment) throw new Error("Relay attachment does not belong to this job")
  return attachment
}

export async function relayArtifactTarget({
  artifactKey,
  deviceId,
  jobId,
}: {
  artifactKey: string
  deviceId: string
  jobId: string
}): Promise<{ payload: RelayJobPayload; uploaded: boolean }> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  if (entity.status !== "claimed" || entity.workerId !== deviceId)
    throw new Error("Relay artifact is not owned by this device")
  const uploaded = new Set(
    entity.uploadedArtifactKeys
      ? UploadedArtifactKeysSchema.parse(JSON.parse(entity.uploadedArtifactKeys))
      : []
  )
  return {
    payload: parseRelayJobPayload(JSON.parse(entity.payload)),
    uploaded: uploaded.has(artifactKey),
  }
}

export async function markRelayArtifactUploaded({
  artifactKey,
  deviceId,
  jobId,
}: {
  artifactKey: string
  deviceId: string
  jobId: string
}): Promise<void> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
  if (entity.status !== "claimed" || entity.workerId !== deviceId)
    throw new Error("Relay artifact is not owned by this device")
  const uploaded = new Set<string>(
    entity.uploadedArtifactKeys
      ? UploadedArtifactKeysSchema.parse(JSON.parse(entity.uploadedArtifactKeys))
      : []
  )
  if (uploaded.has(artifactKey)) return
  uploaded.add(artifactKey)
  await relayClients().jobs.updateEntity(
    {
      partitionKey: "jobs",
      rowKey: jobId,
      uploadedArtifactKeys: JSON.stringify([...uploaded].slice(-20)),
      updatedAt: new Date().toISOString(),
    },
    "Merge",
    { etag: entity.etag }
  )
}

export async function relayEventDeliveryTarget(
  batch: RelayEventBatch
): Promise<{ events: RelayEventEnvelope[]; delivery: RelayDeliveryState }> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>(
    "jobs",
    batch.jobId
  )
  if (entity.status !== "claimed" || entity.workerId !== batch.deviceId)
    throw new Error("Relay events are not owned by this device")
  const events = batch.events.filter(
    (event) =>
      event.cursor.epoch !== entity.deliveredEventEpoch ||
      event.cursor.seq > (entity.deliveredEventSeq ?? 0)
  )
  return {
    events,
    delivery: {
      payload: parseRelayJobPayload(JSON.parse(entity.payload)),
      status: entity.status,
      streamClosed: entity.streamClosed ?? false,
      streamTs: entity.streamTs,
      streamedChars: entity.streamedChars ?? 0,
    },
  }
}

export async function recordRelayEventDelivery(
  jobId: string,
  deviceId: string,
  event: RelayEventEnvelope
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entity = await relayClients().jobs.getEntity<RelayJobEntity>("jobs", jobId)
    if (entity.status !== "claimed" || entity.workerId !== deviceId)
      throw new Error("Relay events are not owned by this device")
    if (
      entity.deliveredEventEpoch === event.cursor.epoch &&
      (entity.deliveredEventSeq ?? 0) >= event.cursor.seq
    )
      return
    try {
      await relayClients().jobs.updateEntity(
        {
          partitionKey: "jobs",
          rowKey: jobId,
          deliveredEventEpoch: event.cursor.epoch,
          deliveredEventSeq: event.cursor.seq,
          updatedAt: new Date().toISOString(),
        },
        "Merge",
        { etag: entity.etag }
      )
      return
    } catch (error) {
      if (!(error instanceof Error) || statusCode(error) !== 412 || attempt === 2)
        throw error
    }
  }
}

export async function appendRelayEvents(
  input: RelayEventEnvelope[]
): Promise<void> {
  for (const event of input.map((value) => RelayEventEnvelopeSchema.parse(value))) {
    const entity: RelayEventEntity = {
      partitionKey: `events:${event.jobId}`,
      rowKey: event.eventId,
      data: JSON.stringify(event),
      epoch: event.cursor.epoch,
      seq: event.cursor.seq,
    }
    try {
      await relayClients().events.createEntity(entity)
    } catch (error) {
      if (!(error instanceof Error) || statusCode(error) !== 409) throw error
    }
  }
}

export async function relayEventsSince({
  jobId,
  epoch,
  seq = 0,
  limit = 100,
}: {
  jobId: string
  epoch?: string
  seq?: number
  limit?: number
}): Promise<RelayEventEnvelope[]> {
  const found: RelayEventEnvelope[] = []
  for await (const entity of relayClients().events.listEntities<RelayEventEntity>({
    queryOptions: { filter: `PartitionKey eq 'events:${jobId}'` },
  })) {
    found.push(RelayEventEnvelopeSchema.parse(JSON.parse(entity.data)))
  }
  return relayEventsAfter(
    found,
    epoch ? { epoch, seq } : undefined
  ).slice(0, limit)
}

export async function reconcileRelayStore(
  tenantId: string
): Promise<{ processed: number; failed: number }> {
  const filter = [
    "PartitionKey eq 'jobs'",
    `originTenantId eq '${escapeFilter(tenantId)}'`,
  ].join(" and ")
  let processed = 0
  let failed = 0
  for await (const entity of relayClients().jobs.listEntities<RelayJobEntity>({
    queryOptions: { filter },
  })) {
    try {
      if (entity.status === "pending" && !entity.queueConfirmed) {
        await enqueueJobMessage(entity.rowKey)
        await relayClients().jobs.updateEntity(
          {
            partitionKey: "jobs",
            rowKey: entity.rowKey,
            queueConfirmed: true,
            status: "queued",
            updatedAt: new Date().toISOString(),
          },
          "Merge"
        )
        processed += 1
      } else if (
        entity.status === "delivered" &&
        entity.pendingDeleteMessageId &&
        entity.pendingDeletePopReceipt
      ) {
        await relayClients().queue
          .deleteMessage(
            entity.pendingDeleteMessageId,
            entity.pendingDeletePopReceipt
          )
          .catch(() => undefined)
        await relayClients().jobs.updateEntity(
          {
            partitionKey: "jobs",
            rowKey: entity.rowKey,
            pendingDeleteMessageId: "",
            pendingDeletePopReceipt: "",
            updatedAt: new Date().toISOString(),
          },
          "Merge"
        )
        processed += 1
      }
    } catch {
      failed += 1
    }
  }
  return { processed, failed }
}

export async function readThreadMapping({
  provider,
  tenantId,
  conversationId,
  threadId,
}: Pick<
  RemoteOrigin,
  "provider" | "tenantId" | "conversationId" | "threadId"
>): Promise<RelayThreadEntity | null> {
  try {
    return await relayClients().threads.getEntity<RelayThreadEntity>(
      `${provider}:${tenantId}:${conversationId}`,
      threadId
    )
  } catch (error) {
    if (error instanceof Error && statusCode(error) === 404) return null
    throw error
  }
}
