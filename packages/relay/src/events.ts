import { randomUUID } from "node:crypto"
import {
  RelayEventEnvelopeSchema,
  type RelayCanonicalEvent,
  type RelayCursor,
  type RelayEventEnvelope,
} from "./schema.js"

export function relayEventsAfter(
  events: RelayEventEnvelope[],
  cursor?: RelayCursor
): RelayEventEnvelope[] {
  if (!cursor) return [...events].sort(compareEvents)
  return events
    .filter(
      (event) =>
        event.cursor.epoch !== cursor.epoch || event.cursor.seq > cursor.seq
    )
    .sort(compareEvents)
}

function compareEvents(left: RelayEventEnvelope, right: RelayEventEnvelope): number {
  if (left.cursor.epoch === right.cursor.epoch)
    return left.cursor.seq - right.cursor.seq
  const time = left.at.localeCompare(right.at)
  return time !== 0 ? time : left.eventId.localeCompare(right.eventId)
}

export class RelayEventSequencer {
  readonly epoch: string
  #seq = 0
  #jobSeq = new Map<string, number>()

  constructor(
    readonly workerId: string,
    epoch = randomUUID()
  ) {
    this.epoch = epoch
  }

  next(jobId: string, event: RelayCanonicalEvent): RelayEventEnvelope {
    this.#seq += 1
    const jobSeq = (this.#jobSeq.get(jobId) ?? 0) + 1
    this.#jobSeq.set(jobId, jobSeq)
    return RelayEventEnvelopeSchema.parse({
      version: 1,
      eventId: randomUUID(),
      jobId,
      workerId: this.workerId,
      cursor: { epoch: this.epoch, seq: this.#seq },
      jobSeq,
      at: new Date().toISOString(),
      event,
    })
  }

  cursor(): RelayCursor {
    return { epoch: this.epoch, seq: this.#seq }
  }
}
