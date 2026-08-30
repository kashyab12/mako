import { randomUUID } from "node:crypto"
import { RelayEventSequencer } from "./events.js"
import type {
  RelayCanonicalEvent,
  RelayCompletion,
  RelayEventBatch,
  RelayEventEnvelope,
  RelayLease,
  RelayLeaseRequest,
} from "./schema.js"

export interface RelayExecution {
  effort?: string
  fast?: boolean
  harness: string
  model?: string
  result: string
  status: "done" | "failed" | "stopped"
  threadPath?: string
}

export interface RelayExecutionContext {
  signal: AbortSignal
  emit: (event: RelayCanonicalEvent) => void
}

export interface RelayExecutor {
  execute(
    lease: RelayLease,
    context: RelayExecutionContext
  ): Promise<RelayExecution>
}

export interface RelayTransport {
  lease(request: RelayLeaseRequest, signal: AbortSignal): Promise<RelayLease | null>
  renew(lease: RelayLease, request: RelayLeaseRequest): Promise<string>
  sendEvents(batch: RelayEventBatch): Promise<void>
  control(lease: RelayLease, deviceId: string): Promise<"stop" | null>
  complete(completion: RelayCompletion): Promise<void>
}

export interface HeadlessRelayWorkerOptions {
  heartbeat: Omit<RelayLeaseRequest, "visibilityTimeoutSeconds">
  visibilityTimeoutSeconds?: number
  idleDelay?: (emptyPolls: number) => number
  controlIntervalMs?: number
  renewIntervalMs?: number
  eventFlushMs?: number
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

export class HeadlessRelayWorker {
  #controller: AbortController | null = null
  #running: Promise<void> | null = null
  readonly #sequencer: RelayEventSequencer

  constructor(
    readonly transport: RelayTransport,
    readonly executor: RelayExecutor,
    readonly options: HeadlessRelayWorkerOptions
  ) {
    this.#sequencer = new RelayEventSequencer(options.heartbeat.deviceId)
  }

  start(): void {
    if (this.#running) return
    this.#controller = new AbortController()
    this.#running = this.#loop(this.#controller.signal).finally(() => {
      this.#controller = null
      this.#running = null
    })
  }

  async stop(): Promise<void> {
    this.#controller?.abort()
    await this.#running
  }

  async runOnce(signal = new AbortController().signal): Promise<boolean> {
    const request: RelayLeaseRequest = {
      ...this.options.heartbeat,
      visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds ?? 300,
    }
    const lease = await this.transport.lease(request, signal)
    if (!lease || signal.aborted) return false
    await this.#execute(lease, request, signal)
    return true
  }

  async #loop(signal: AbortSignal): Promise<void> {
    let emptyPolls = 0
    while (!signal.aborted) {
      try {
        const worked = await this.runOnce(signal)
        emptyPolls = worked ? 0 : Math.min(emptyPolls + 1, 4)
      } catch {
        if (!signal.aborted) await delay(5_000, signal)
        continue
      }
      if (!signal.aborted) {
        const wait = this.options.idleDelay?.(emptyPolls) ??
          Math.min(1_500 * 2 ** emptyPolls, 15_000)
        await delay(wait, signal)
      }
    }
  }

  async #execute(
    lease: RelayLease,
    request: RelayLeaseRequest,
    workerSignal: AbortSignal
  ): Promise<void> {
    const turn = new AbortController()
    const stop = () => turn.abort()
    workerSignal.addEventListener("abort", stop, { once: true })
    let popReceipt = lease.popReceipt
    let renewal = Promise.resolve()
    let controls = Promise.resolve()
    let events = Promise.resolve()
    let eventFailure = false
    let pending: RelayEventEnvelope[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined

    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = undefined
      if (pending.length === 0 || eventFailure) return
      const sending = pending
      pending = []
      events = events
        .then(() =>
          this.transport.sendEvents({
            deviceId: request.deviceId,
            jobId: lease.jobId,
            cursor: sending.at(-1)?.cursor,
            events: sending,
          })
        )
        .catch(() => {
          eventFailure = true
        })
    }

    const emit = (event: RelayCanonicalEvent) => {
      pending.push(this.#sequencer.next(lease.jobId, event))
      if (pending.length >= 50) flush()
      else flushTimer ??= setTimeout(flush, this.options.eventFlushMs ?? 250)
    }

    emit({ kind: "lifecycle", status: "starting" })
    const renewTimer = setInterval(() => {
      renewal = renewal
        .then(async () => {
          popReceipt = await this.transport.renew(
            { ...lease, popReceipt },
            request
          )
        })
        .catch(() => turn.abort())
    }, this.options.renewIntervalMs ?? 180_000)
    const controlTimer = setInterval(() => {
      controls = controls
        .then(async () => {
          if (
            (await this.transport.control(lease, request.deviceId)) === "stop"
          )
            turn.abort()
        })
        .catch(() => undefined)
    }, this.options.controlIntervalMs ?? 2_000)

    let execution: RelayExecution
    try {
      execution = await this.executor.execute(lease, {
        signal: turn.signal,
        emit,
      })
    } finally {
      clearInterval(renewTimer)
      clearInterval(controlTimer)
      workerSignal.removeEventListener("abort", stop)
      flush()
      await Promise.all([renewal, controls, events])
    }

    emit({
      kind: "lifecycle",
      status:
        execution.status === "done"
          ? "completed"
          : execution.status === "stopped"
            ? "stopped"
            : "failed",
    })
    flush()
    await events
    await this.#completeWithRetry({
      deviceId: request.deviceId,
      effort: execution.effort,
      fast: execution.fast,
      harness: execution.harness,
      jobId: lease.jobId,
      messageId: lease.messageId,
      model: execution.model,
      popReceipt,
      progressFailed: eventFailure,
      result: execution.result,
      status: execution.status,
      threadPath: execution.threadPath,
    })
  }

  async #completeWithRetry(completion: RelayCompletion): Promise<void> {
    let failure: Error | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.transport.complete(completion)
        return
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      }
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    throw failure ?? new Error("Relay completion failed")
  }
}

export function createWorkerId(): string {
  return randomUUID()
}
