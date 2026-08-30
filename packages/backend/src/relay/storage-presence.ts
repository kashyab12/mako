import { randomBytes } from "node:crypto"
import { type TableEntity } from "@azure/data-tables"
import { relayDeviceKey } from "@mako/relay"
import type { WorkerHeartbeat } from "./types"
import { relayClients, statusCode } from "./storage"

export interface RelayWorkerEntity extends TableEntity {
  defaultHarness: string
  defaultModel?: string
  deviceName: string
  lastSeenAt: string
  version: string
}

interface RelayRegistrationEntity extends TableEntity {
  deviceKey: string
  deviceName: string
  lastTokenNonce?: string
  lastTokenTimestamp?: number
  registeredAt: string
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

export async function consumeRelayTokenRequest({
  tenantId,
  deviceId,
  nonce,
  timestamp,
}: {
  tenantId: string
  deviceId: string
  nonce: string
  timestamp: number
}): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entity = await relayClients().registrations.getEntity<RelayRegistrationEntity>(
      `registrations:${tenantId}`,
      deviceId
    )
    if (timestamp <= (entity.lastTokenTimestamp ?? 0)) return false
    try {
      await relayClients().registrations.updateEntity(
        {
          partitionKey: `registrations:${tenantId}`,
          rowKey: deviceId,
          lastTokenNonce: nonce,
          lastTokenTimestamp: timestamp,
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

export async function activeWorker(
  teamId: string
): Promise<RelayWorkerEntity | null> {
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
