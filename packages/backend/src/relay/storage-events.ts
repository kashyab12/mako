import { type TableEntity } from "@azure/data-tables"
import {
  RelayEventEnvelopeSchema,
  relayEventsAfter,
  type RelayEventBatch,
  type RelayEventEnvelope,
} from "@mako/relay"
import {
  relayClients,
  statusCode,
  type RelayDeliveryState,
  type RelayJobEntity,
} from "./storage"
import { parseRelayJobPayload } from "./types"

interface RelayEventEntity extends TableEntity {
  data: string
  delivered: boolean
  epoch: string
  seq: number
}

export async function relayEventDeliveryTarget(
  batch: RelayEventBatch
): Promise<{ events: RelayEventEnvelope[]; delivery: RelayDeliveryState }> {
  const entity = await relayClients().jobs.getEntity<RelayJobEntity>(
    "jobs",
    batch.jobId
  )
  if (
    (entity.status !== "claimed" && entity.status !== "completed") ||
    entity.workerId !== batch.deviceId
  )
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
    if (
      (entity.status !== "claimed" && entity.status !== "completed") ||
      entity.workerId !== deviceId
    )
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
          streamedChars:
            (entity.streamedChars ?? 0) +
            (event.event.kind === "text" ? event.event.text.length : 0),
          updatedAt: new Date().toISOString(),
        },
        "Merge",
        { etag: entity.etag }
      )
      await relayClients().events.updateEntity(
        {
          partitionKey: `events:${jobId}`,
          rowKey: event.eventId,
          delivered: true,
        },
        "Merge"
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
      delivered: false,
      epoch: event.cursor.epoch,
      seq: event.cursor.seq,
    }
    try {
      await relayClients().events.createEntity(entity)
    } catch (error) {
      if (!(error instanceof Error) || statusCode(error) !== 409) throw error
    }
    if (event.event.kind === "permission") {
      const job = await relayClients().jobs.getEntity<RelayJobEntity>(
        "jobs",
        event.jobId
      )
      const payload = parseRelayJobPayload(JSON.parse(job.payload))
      await relayClients().jobs.updateEntity(
        {
          partitionKey: "jobs",
          rowKey: event.jobId,
          pendingPermission: JSON.stringify({
            optionIds: event.event.options.map((option) => option.id),
            requestId: event.event.id,
            userId: payload.origin.userId,
          }),
          updatedAt: new Date().toISOString(),
        },
        "Merge"
      )
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
    if (!entity.delivered)
      found.push(RelayEventEnvelopeSchema.parse(JSON.parse(entity.data)))
  }
  return relayEventsAfter(
    found,
    epoch ? { epoch, seq } : undefined
  ).slice(0, limit)
}
