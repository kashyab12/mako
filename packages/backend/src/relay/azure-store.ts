import type { RelayStore } from "@mako/relay"
import {
  enqueueRelayJob,
  leaseRelayJob,
  markRelayArtifactUploaded,
  markRelayDelivered,
  readThreadMapping,
  reconcileRelayStore,
  recordRelayCompletion,
  recordRelayProgress,
  recordRelayStream,
  recordRelayStreamClosed,
  relayArtifactTarget,
  relayAttachment,
  relayControl,
  relayDeliveryState,
  relayProgressTarget,
  relayQueueStatus,
  renewRelayLease,
  requestRelayStop,
} from "./storage"
import {
  appendRelayEvents,
  recordRelayEventDelivery,
  relayEventDeliveryTarget,
  relayEventsSince,
} from "./storage-events"
import {
  activeWorker,
  consumeRelayTokenRequest,
  heartbeatWorker,
  registerRelayDevice,
  relayDeviceKeyFor,
  workerById,
} from "./storage-presence"

export const azureRelayStore = {
  registerDevice: registerRelayDevice,
  deviceKey: relayDeviceKeyFor,
  consumeTokenRequest: consumeRelayTokenRequest,
  enqueue: enqueueRelayJob,
  heartbeat: (tenantId, heartbeat) =>
    heartbeatWorker({ heartbeat, teamId: tenantId }),
  worker: async (tenantId, deviceId) => {
    const entity = await workerById(tenantId, deviceId)
    return entity
      ? {
          tenantId,
          deviceId: entity.rowKey,
          defaultHarness: entity.defaultHarness,
          defaultModel: entity.defaultModel,
          deviceName: entity.deviceName,
          lastSeenAt: entity.lastSeenAt,
          version: entity.version,
        }
      : null
  },
  activeWorker: async (tenantId) => {
    const entity = await activeWorker(tenantId)
    return entity
      ? {
          tenantId,
          deviceId: entity.rowKey,
          defaultHarness: entity.defaultHarness,
          defaultModel: entity.defaultModel,
          deviceName: entity.deviceName,
          lastSeenAt: entity.lastSeenAt,
          version: entity.version,
        }
      : null
  },
  lease: leaseRelayJob,
  renew: renewRelayLease,
  recordCompletion: recordRelayCompletion,
  markDelivered: markRelayDelivered,
  delivery: relayDeliveryState,
  recordStream: recordRelayStream,
  recordStreamClosed: recordRelayStreamClosed,
  progressTarget: relayProgressTarget,
  recordProgress: recordRelayProgress,
  appendEvents: appendRelayEvents,
  eventsAfter: relayEventsSince,
  queueStatus: relayQueueStatus,
  requestStop: requestRelayStop,
  control: relayControl,
  attachment: ({ jobId, attachmentId, deviceId }) =>
    relayAttachment(jobId, attachmentId, deviceId),
  artifactTarget: relayArtifactTarget,
  markArtifactUploaded: markRelayArtifactUploaded,
  thread: readThreadMapping,
  reconcile: reconcileRelayStore,
} satisfies RelayStore

export {
  recordRelayEventDelivery,
  relayEventDeliveryTarget,
}
