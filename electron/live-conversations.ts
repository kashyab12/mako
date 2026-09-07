import { join } from "node:path"
import { LiveAssets } from "./live-assets.js"
import type { ThreadPage } from "@mako/sessions"
import { z } from "zod"
import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  HostEvent,
  LiveBatch,
  LiveDriverEvent,
  LiveRequest,
  LiveSnapshot,
  LiveStartOptions,
  LiveSummary,
} from "./shared.js"
import { reduceLiveUpdates } from "./contracts/live-content.js"
import type { ProviderLiveDriver } from "./providers/live-driver.js"
import { LiveJournal, LiveRequestSchema, journalIds } from "./live-journal.js"

interface Resident {
  snapshot: LiveSnapshot
  journalSnapshot?: LiveSnapshot
  journal: LiveJournal
  driver: ProviderLiveDriver | null
  storageFault?: boolean
  generation: number
  opening: boolean
  pendingCharacters: number
  updates: LiveBatch["updates"]
  timer: ReturnType<typeof setTimeout> | null
  displayPrompt?: string
}

interface Dependencies {
  appPath: string
  root: string
  driver(provider: string): ProviderLiveDriver | undefined
  history(path: string, before?: number): Promise<ThreadPage | null>
  emit(event: HostEvent): void
}

/** Owns durable conversation intent and observation. Providers still own execution. */
export class LiveConversations {
  private readonly records = new Map<string, Resident>()
  private readonly starts = new Map<string, Promise<LiveSessionState>>()
  private readonly recovered = new Map<string, LiveSummary>()
  private readonly assets: LiveAssets
  private readonly dependencies: Dependencies
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
    this.assets = new LiveAssets(join(dependencies.root, "assets"))
    for (const id of journalIds(dependencies.root)) {
      try {
        const journal = new LiveJournal(dependencies.root, id)
        try {
          const summary = journal.summary()
          if (summary)
            this.recovered.set(id, {
              ...summary,
              session: {
                ...summary.session,
                status: "failed",
                connection: "disconnected",
                error:
                  "The previous provider connection ended. Its saved output is available.",
              },
            })
        } finally {
          journal.close()
        }
      } catch (error) {
        dependencies.emit({
          type: "notice",
          level: "error",
          message: `Saved conversation ${id} could not be opened. Its journal has been preserved for recovery. ${errorMessage({ error })}`,
        })
      }
    }
  }

  summaries(): LiveSummary[] {
    return [
      ...this.recovered.values(),
      ...[...this.records.values()].map(({ snapshot }) => ({
        session: snapshot.session,
        revision: snapshot.revision,
        threadPath: snapshot.threadPath,
        createdAt: snapshot.createdAt,
      })),
    ]
  }

  snapshot(id: string): LiveSnapshot | null {
    const resident = this.load(id)
    if (!resident) return null
    this.flush(resident)
    return resident.snapshot
  }

  start(
    provider: string,
    cwd: string,
    options: LiveStartOptions
  ): Promise<LiveSessionState> {
    z.string().uuid().parse(options.conversationId)
    const pending = this.starts.get(options.conversationId)
    if (pending) return pending
    const existing = this.load(options.conversationId)
    if (existing) {
      if (
        existing.snapshot.session.harness !== provider ||
        existing.snapshot.session.cwd !== cwd
      )
        return Promise.reject(
          new Error(
            "This conversation ID already belongs to a different provider or workspace"
          )
        )
      return Promise.resolve(existing.snapshot.session)
    }
    const start = this.open(provider, cwd, options)
    this.starts.set(options.conversationId, start)
    void start
      .finally(() => this.starts.delete(options.conversationId))
      .catch(() => {})
    return start
  }

  private async open(
    provider: string,
    cwd: string,
    options: LiveStartOptions
  ): Promise<LiveSessionState> {
    const driver = this.dependencies.driver(provider)
    if (!driver?.available(this.dependencies.appPath))
      throw new Error(`${provider} has no available interactive transport`)
    const base = options.threadPath
      ? await this.dependencies.history(options.threadPath)
      : null
    if (options.threadPath && !base)
      throw new Error(
        "The saved history could not be loaded; the conversation was not started"
      )
    const id = options.conversationId
    const snapshot: LiveSnapshot = {
      session: {
        id,
        harness: provider,
        cwd,
        title: options.title,
        status: "starting",
        connection: "starting",
        modes: [],
        currentMode: null,
        configOptions: [],
      },
      revision: 0,
      threadPath: options.threadPath,
      createdAt: Date.now(),
      base,
      blocks: [],
      permissions: [],
      requests: options.initialRequest
        ? [
            LiveRequestSchema.parse({
              ...options.initialRequest,
              status: "queued",
            }),
          ]
        : [],
    }
    const resident: Resident = {
      snapshot,
      journalSnapshot: snapshot,
      driver,
      journal: new LiveJournal(this.dependencies.root, id),
      generation: 0,
      opening: true,
      pendingCharacters: 0,
      updates: [],
      timer: null,
      displayPrompt: options.displayPrompt,
    }
    resident.journal.commit(snapshot)
    this.records.set(id, resident)
    const generation = resident.generation
    void driver
      .start(cwd, options)
      .then((session) => {
        if (resident.generation !== generation) {
          driver.close(id)
          return
        }
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...session,
            title: session.title ?? resident.snapshot.session.title,
          },
        }
        resident.opening = false
        this.flush(resident)
        this.drain(resident)
      })
      .catch((error) => {
        if (resident.generation !== generation) return
        resident.opening = false
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...resident.snapshot.session,
            status: "failed",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((request) =>
            request.status === "queued"
              ? { ...request, status: "failed", error: errorMessage({ error }) }
              : request
          ),
        }
        this.flush(resident)
      })
    return snapshot.session
  }

  observe(event: LiveDriverEvent): void {
    try {
      this.accept(event)
    } catch (error) {
      const id =
        event.type === "acp-session"
          ? event.session.id
          : event.type === "acp-permission"
            ? event.request.sessionId
            : event.id
      const resident = this.records.get(id)
      if (resident) this.storageFailed(resident, { error })
    }
  }

  private accept(event: LiveDriverEvent): void {
    const id =
      event.type === "acp-session"
        ? event.session.id
        : event.type === "acp-permission"
          ? event.request.sessionId
          : event.id
    const resident = this.records.get(id)
    if (!resident?.driver) return
    if (event.type === "acp-session") {
      const previousStatus = resident.snapshot.session.status
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...event.session,
          title: event.session.title ?? resident.snapshot.session.title,
        },
      }
      if (event.session.connection === "disconnected") resident.driver = null
      if (previousStatus === "running" && event.session.status !== "running") {
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching"
              ? {
                  ...request,
                  status: /cancel|interrupt/i.test(event.session.lastStop ?? "")
                    ? "interrupted"
                    : event.session.status === "ready"
                      ? "completed"
                      : "failed",
                  error: event.session.error,
                }
              : request
          ),
        }
      }
    } else if (event.type === "acp-permission") {
      resident.snapshot = {
        ...resident.snapshot,
        permissions: [
          ...resident.snapshot.permissions.filter(
            (request) => request.id !== event.request.id
          ),
          event.request,
        ],
      }
    } else if (!(
      resident.opening &&
      (resident.snapshot.base || resident.snapshot.blocks.length)
    )) {
      const updates =
        event.type === "acp-update" ? [event.update] : event.updates
      const dispatching = resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
      const prepared = updates.flatMap((item) => {
        try {
          return this.assets.prepare(item)
        } catch (error) {
          resident.updates.push(item)
          this.storageFailed(resident, { error })
          return []
        }
      })
      for (const update of prepared) {
        if (dispatching && update.kind === "user") continue
        const characters = JSON.stringify(update).length
        if (
          resident.updates.length >= 128 ||
          resident.pendingCharacters + characters > 256_000
        )
          this.flush(resident)
        resident.updates.push(update)
        resident.pendingCharacters += characters
      }
    }
    // Control and terminal changes flush ahead of the next turn. Text bursts share one frame.
    if (event.type === "acp-session" || event.type === "acp-permission")
      this.flush(resident)
    else this.schedule(resident)
    if (!resident.opening && resident.snapshot.session.status === "ready")
      this.drain(resident)
  }

  submit(
    id: string,
    requestId: string,
    text: string,
    attachments: PromptAttachment[] = []
  ): LiveRequest {
    const resident = this.require(id)
    this.flush(resident)
    const request = LiveRequestSchema.parse({
      id: requestId,
      text,
      attachments,
      status: "queued",
    })
    const existing = resident.snapshot.requests.find(
      (candidate) => candidate.id === request.id
    )
    if (existing) {
      if (
        existing.text !== text ||
        JSON.stringify(existing.attachments) !== JSON.stringify(attachments)
      )
        throw new Error(
          "This request ID was already accepted with different content"
        )
      if (existing.status === "queued") this.drain(resident)
      return existing
    }
    if (!text.trim() && !attachments.length)
      throw new Error("A prompt cannot be empty")
    if (!resident.driver)
      throw new Error(
        "This saved capture is disconnected. Continue from the provider’s current native history."
      )
    const previousSnapshot = resident.snapshot
    resident.snapshot = {
      ...resident.snapshot,
      requests: [...resident.snapshot.requests, request],
    }
    // Rejected acceptance must never become a later executable request.
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      throw error
    }
    this.drain(resident)
    return request
  }

  clearQueue(id: string): LiveSnapshot {
    const resident = this.require(id)
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) =>
        request.status === "queued"
          ? {
              ...request,
              status: "failed",
              error: "Removed from the queue by the user",
            }
          : request
      ),
    }
    this.flush(resident)
    return resident.snapshot
  }

  async earlier(id: string): Promise<LiveSnapshot> {
    const resident = this.require(id)
    const base = resident.snapshot.base
    if (!base?.hasEarlier) return resident.snapshot
    const earlier = await this.dependencies.history(base.ref.path, base.start)
    if (
      earlier &&
      JSON.stringify([
        earlier.checkpoint,
        earlier.ref.revision,
        earlier.ref.bytes,
        earlier.ref.updatedAt,
      ]) !==
        JSON.stringify([
          base.checkpoint,
          base.ref.revision,
          base.ref.bytes,
          base.ref.updatedAt,
        ])
    )
      throw new Error(
        "The native history changed since this capture. Open the current provider history to read earlier turns."
      )
    // Another caller may already have prepended this page.
    if (
      earlier &&
      resident.snapshot.base === base &&
      earlier.total >= base.total &&
      earlier.start < base.start
    ) {
      resident.snapshot = {
        ...resident.snapshot,
        base: {
          ...base,
          entries: [...earlier.entries, ...base.entries],
          start: earlier.start,
          hasEarlier: earlier.hasEarlier,
        },
      }
      this.flush(resident)
    }
    return resident.snapshot
  }

  async bind(id: string, path: string): Promise<LiveSnapshot> {
    const resident = this.require(id)
    const page = await this.dependencies.history(path)
    if (
      !page ||
      page.ref.nativeId !== resident.snapshot.session.nativeId ||
      page.ref.harness !== resident.snapshot.session.harness
    )
      throw new Error(
        "That native session does not belong to this conversation"
      )
    resident.snapshot = { ...resident.snapshot, threadPath: path }
    this.flush(resident)
    return resident.snapshot
  }

  async permission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): Promise<void> {
    const resident = this.require(id)
    const request = resident.snapshot.permissions.find(
      (candidate) => candidate.id === requestId
    )
    if (!request || !resident.driver)
      throw new Error("That permission request is no longer pending")
    await resident.driver.permission(id, requestId, response)
    resident.snapshot = {
      ...resident.snapshot,
      permissions: resident.snapshot.permissions.filter(
        (candidate) => candidate.id !== requestId
      ),
    }
    this.flush(resident)
  }

  async cancel(id: string): Promise<void> {
    const resident = this.require(id)
    await resident.driver?.cancel(id)
  }
  async setMode(id: string, modeId: string): Promise<void> {
    const resident = this.require(id)
    if (!resident.driver) throw new Error("The provider is disconnected")
    await resident.driver.setMode(id, modeId)
  }
  close(id: string): void {
    const resident = this.require(id)
    resident.generation += 1
    resident.driver?.close(id)
    resident.driver = null
    resident.snapshot = {
      ...resident.snapshot,
      session: { ...resident.snapshot.session, status: "closed" },
      permissions: [],
      requests: resident.snapshot.requests.map((request) =>
        request.status === "queued" || request.status === "dispatching"
          ? {
              ...request,
              status: "uncertain",
              error: "The connection closed before completion",
            }
          : request
      ),
    }
    this.flush(resident)
  }

  stop(): void {
    for (const resident of this.records.values()) {
      resident.generation += 1
      const driver = resident.driver
      resident.driver = null
      driver?.close(resident.snapshot.session.id)
      this.flush(resident)
      resident.journal.close()
    }
    this.records.clear()
  }

  private drain(resident: Resident): void {
    if (
      resident.opening ||
      !resident.driver ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
    )
      return
    // Failure does not silently drain old queued work. A new explicit submission can retry.
    const queued = resident.snapshot.requests.filter(
      (request) => request.status === "queued"
    )
    const request =
      resident.snapshot.session.status === "failed" ? queued.at(-1) : queued[0]
    if (!request) return
    const previousSnapshot = resident.snapshot
    const previousUpdates = [...resident.updates]
    const previousCharacters = resident.pendingCharacters
    const previousDisplayPrompt = resident.displayPrompt
    const current = { ...request, status: "dispatching" as const }
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((candidate) =>
        candidate.id === request.id ? current : candidate
      ),
    }
    const text = resident.displayPrompt ?? request.text
    resident.displayPrompt = undefined
    if (text || request.attachments.length)
      resident.updates.push({
        kind: "user",
        text,
        attachments: request.attachments.map((attachment) => ({
          type: "attachment",
          name: attachment.name,
          mimeType: attachment.mimeType,
          source: attachment.path
            ? { kind: "file", path: attachment.path }
            : attachment.data
              ? { kind: "inline", data: attachment.data }
              : {
                  kind: "unavailable",
                  reason: "Attachment bytes were not retained",
                },
        })),
      })
    try {
      this.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      resident.updates = previousUpdates
      resident.pendingCharacters = previousCharacters
      resident.displayPrompt = previousDisplayPrompt
      this.storageFailed(resident, { error })
      return
    }
    const generation = resident.generation
    void resident.driver
      .prompt(resident.snapshot.session.id, request.text, request.attachments)
      .catch((error) => {
        if (
          generation !== resident.generation ||
          !resident.snapshot.requests.some(
            (candidate) =>
              candidate.id === request.id && candidate.status === "dispatching"
          )
        )
          return
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...resident.snapshot.session,
            status: "failed",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((candidate) =>
            candidate.id === request.id
              ? {
                  ...candidate,
                  status: "failed",
                  error: errorMessage({ error }),
                }
              : candidate
          ),
        }
        this.flush(resident)
      })
  }

  private schedule(resident: Resident): void {
    resident.timer ??= setTimeout(() => {
      try {
        this.flush(resident)
      } catch (error) {
        this.storageFailed(resident, { error })
      }
    }, 16)
  }

  private flush(resident: Resident): void {
    if (resident.timer) clearTimeout(resident.timer)
    resident.timer = null
    const previous = resident.journalSnapshot ?? resident.snapshot
    if (
      !resident.updates.length &&
      resident.journalSnapshot === resident.snapshot
    )
      return
    const updates = resident.updates
    const snapshot = {
      ...resident.snapshot,
      blocks: reduceLiveUpdates(resident.snapshot.blocks, updates),
      revision: resident.snapshot.revision + 1,
    }
    resident.journal.commit(snapshot, previous)
    resident.storageFault = false
    resident.updates = []
    resident.pendingCharacters = 0
    resident.snapshot = snapshot
    resident.journalSnapshot = snapshot
    this.dependencies.emit({
      type: "live-batch",
      batch: {
        id: snapshot.session.id,
        revision: snapshot.revision,
        updates,
        base: previous.base !== snapshot.base ? snapshot.base : undefined,
        threadPath:
          previous.threadPath !== snapshot.threadPath
            ? snapshot.threadPath
            : undefined,
        session:
          previous.session !== snapshot.session ? snapshot.session : undefined,
        permissions:
          previous.permissions !== snapshot.permissions
            ? snapshot.permissions
            : undefined,
        requests:
          previous.requests !== snapshot.requests
            ? snapshot.requests
            : undefined,
      },
    })
  }

  private storageFailed(resident: Resident, boundary: FailureBoundary): void {
    if (resident.storageFault) return
    resident.storageFault = true
    this.dependencies.emit({
      type: "notice",
      level: "error",
      message: `The conversation could not be saved. The provider is being stopped; buffered output is retained in memory. ${errorMessage(boundary)}`,
    })
    void resident.driver?.cancel(resident.snapshot.session.id).catch(() => {})
  }

  private require(id: string): Resident {
    const resident = this.load(id)
    if (!resident) throw new Error("This conversation is unavailable")
    return resident
  }

  private load(id: string): Resident | undefined {
    const existing = this.records.get(id)
    if (existing) return existing
    if (!this.recovered.has(id)) return undefined
    const journal = new LiveJournal(this.dependencies.root, id)
    const previous = journal.read()
    if (!previous) {
      journal.close()
      return undefined
    }
    const snapshot: LiveSnapshot = {
      ...previous,
      session: {
        ...previous.session,
        status: "failed",
        connection: "disconnected",
        error:
          "The previous provider connection ended. Resume the native session to continue.",
      },
      permissions: [],
      requests: previous.requests.map((request) =>
        request.status === "dispatching"
          ? {
              ...request,
              status: "uncertain",
              error: "The host restarted before completion was confirmed",
            }
          : request
      ),
    }
    journal.commit(snapshot, previous)
    const resident: Resident = {
      snapshot,
      journal,
      journalSnapshot: snapshot,
      driver: null,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    }
    this.records.set(id, resident)
    this.recovered.delete(id)
    return resident
  }
}

interface FailureBoundary {
  error: unknown
}
function errorMessage({ error }: FailureBoundary): string {
  return error instanceof Error ? error.message : String(error)
}
