import { captureNativeHistory } from "./native-history.js"
import { prepareLiveContext, contextPrompt } from "./live-context.js"
import { LiveTransfers } from "./live-transfers.js"
import { LiveChildren } from "./live-children.js"
import { errorMessage } from "./live-runtime.js"
import type {
  LiveAccess,
  Dependencies,
  Resident,
  FailureBoundary,
} from "./live-runtime.js"
import { ForkInputSchema } from "./contracts/conversation-control.js"
import type {
  DelegateInput,
  ForkInput,
  TransferInput,
  ConversationControl,
} from "./contracts/conversation-control.js"
import { liveEntries } from "./live-context.js"
import { join } from "node:path"
import { LiveAssets, promptFingerprint } from "./live-assets.js"
import type { ThreadPage } from "@mako/sessions"
import { z } from "zod"
import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveDriverEvent,
  LiveRequest,
  LiveSnapshot,
  LiveStartOptions,
  LiveSummary,
} from "./shared.js"
import { reduceLiveUpdates } from "./contracts/live-content.js"

import { LiveJournal, LiveRequestSchema, journalIds } from "./live-journal.js"

/** Owns durable conversation intent and observation. Providers still own execution. */
export class LiveConversations {
  private readonly transfers: LiveTransfers
  private readonly children: LiveChildren
  private readonly records = new Map<string, Resident>()
  private readonly bindingOwners = new Map<string, string>()
  private readonly captures = new Map<string, Promise<LiveSnapshot>>()
  private readonly starts = new Map<string, Promise<LiveSessionState>>()
  private readonly recovered = new Map<string, LiveSummary>()
  private readonly assets: LiveAssets
  private readonly dependencies: Dependencies
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies
    this.assets = new LiveAssets(join(dependencies.root, "assets"))
    const access: LiveAccess = {
      retainAttachments: (attachments) => this.assets.retainPrompt(attachments),
      close: (id) => this.close(id),
      pending: (resident) => this.transfers.pending(resident),
      storageFailed: (resident, boundary) =>
        this.storageFailed(resident, boundary),
      dependencies,
      bindingOwners: this.bindingOwners,
      require: (id) => this.require(id),
      load: (id) => this.load(id),
      control: (resident) => this.control(resident),
      flush: (resident) => this.flush(resident),
      drain: (resident) => this.drain(resident),
      open: (provider, cwd, options, ancestry) =>
        this.open(provider, cwd, options, ancestry),
    }
    this.transfers = new LiveTransfers(access)
    this.children = new LiveChildren(access)
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
                status:
                  summary.session.status === "closed"
                    ? "closed"
                    : summary.session.status === "ready"
                      ? "ready"
                      : "failed",
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
        nativePaths: snapshot.control?.bindings.flatMap((binding) =>
          binding.path ? [binding.path] : []
        ),
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

  capture(id: string, path: string): Promise<LiveSnapshot> {
    z.string().uuid().parse(id)
    const owned = this.summaries().find(
      (summary) =>
        summary.threadPath === path || summary.nativePaths?.includes(path)
    )
    if (owned) return Promise.resolve(this.require(owned.session.id).snapshot)
    const pending = this.captures.get(path)
    if (pending) return pending
    const work = this.captureNative(id, path)
    this.captures.set(path, work)
    void work.finally(() => this.captures.delete(path)).catch(() => {})
    return work
  }

  private async captureNative(id: string, path: string): Promise<LiveSnapshot> {
    const existing = this.load(id)
    if (existing) {
      if (existing.snapshot.base?.ref.path !== path)
        throw new Error("This conversation ID belongs to another source")
      return existing.snapshot
    }
    const base = await captureNativeHistory(path, this.dependencies.history)
    if (!base) throw new Error("The source history could not be captured")
    const snapshot: LiveSnapshot = {
      session: {
        id,
        harness: base.ref.harness,
        nativeId: base.ref.nativeId,
        cwd: base.ref.cwd ?? "",
        title: base.ref.title,
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: null,
        configOptions: [],
      },
      revision: 0,
      createdAt: Date.now(),
      threadPath: path,
      base,
      blocks: [],
      permissions: [],
      requests: [],
      control: {
        children: [],
        merges: [],
        activeBindingId: id,
        bindings: [
          {
            id,
            provider: base.ref.harness,
            nativeId: base.ref.nativeId,
            path,
            coveredBlocks: 0,
            includesBase: true,
          },
        ],
        transfers: [],
      },
    }
    const journal = new LiveJournal(this.dependencies.root, id)
    try {
      journal.commit(snapshot)
    } catch (error) {
      journal.close()
      throw error
    }
    this.records.set(id, {
      snapshot,
      journalSnapshot: snapshot,
      journal,
      driver: null,
      connections: new Map(),
      transferring: false,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    })
    return snapshot
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
    options: LiveStartOptions,
    ancestry?: ConversationControl["ancestry"]
  ): Promise<LiveSessionState> {
    const driver = this.dependencies.driver(provider)
    if (!driver?.available(this.dependencies.appPath))
      throw new Error(`${provider} has no available interactive transport`)
    const base = options.threadPath
      ? await captureNativeHistory(
          options.threadPath,
          this.dependencies.history
        )
      : null
    if (options.threadPath && !base)
      throw new Error(
        "The saved history could not be loaded; the conversation was not started"
      )
    const id = options.conversationId
    const snapshot: LiveSnapshot = {
      control: {
        children: [],
        merges: [],
        ancestry,
        activeBindingId: id,
        bindings: [
          {
            id,
            provider,
            coveredBlocks: 0,
            includesBase: Boolean(options.resume) || !base,
            nativeId: options.resume,
            path: options.threadPath,
            tuning: options.tuning,
          },
        ],
        transfers: [],
      },
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
              inputDigest: promptFingerprint(
                options.initialRequest.text,
                options.initialRequest.attachments
              ),
              attachments: this.assets.retainPrompt(
                options.initialRequest.attachments
              ),
              status: "queued",
            }),
          ]
        : [],
    }
    const resident: Resident = {
      connections: new Map(),
      transferring: false,
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
    this.bindingOwners.set(id, id)
    const generation = resident.generation
    void driver
      .start(cwd, {
        ...options,
        conversationTools: this.dependencies.tools?.(id, id),
      })
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
        resident.connections.set(id, { driver, session })
        this.updateBinding(resident, session)
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
      const resident = this.records.get(this.bindingOwners.get(id) ?? id)
      if (resident) this.storageFailed(resident, { error })
    }
  }

  private accept(raw: LiveDriverEvent): void {
    const bindingId =
      raw.type === "acp-session"
        ? raw.session.id
        : raw.type === "acp-permission"
          ? raw.request.sessionId
          : raw.id
    const owner = this.bindingOwners.get(bindingId) ?? bindingId
    const bound = this.records.get(owner)
    if (!bound) return
    if (this.control(bound).activeBindingId !== bindingId) {
      const connection = bound.connections.get(bindingId)
      if (connection && raw.type === "acp-session") {
        connection.session = raw.session
        if (raw.session.connection === "disconnected")
          bound.connections.delete(bindingId)
      }
      return
    }
    const event: LiveDriverEvent =
      raw.type === "acp-session"
        ? { ...raw, session: { ...raw.session, id: owner } }
        : raw.type === "acp-permission"
          ? { ...raw, request: { ...raw.request, sessionId: owner } }
          : { ...raw, id: owner }
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
      if (event.session.nativeRunId && event.session.status === "running") {
        const runId = event.session.nativeRunId
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching" && !request.nativeRun
              ? { ...request, nativeRun: { bindingId, runId } }
              : request
          ),
        }
      }
      this.updateBinding(resident, event.session)
      const connection = resident.connections.get(bindingId)
      if (connection) connection.session = { ...event.session, id: bindingId }
      if (event.session.connection === "disconnected") {
        resident.driver = null
        resident.connections.delete(bindingId)
      }
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
    if (this.transfers.pending(resident))
      throw new Error(
        "A provider switch is pending. Wait for it to settle before sending another message."
      )
    this.flush(resident)
    const request = LiveRequestSchema.parse({
      id: requestId,
      text,
      attachments,
      status: "queued",
    })
    const inputDigest = promptFingerprint(request.text, request.attachments)
    const existing = resident.snapshot.requests.find(
      (candidate) => candidate.id === request.id
    )
    if (existing) {
      if (
        existing.inputDigest
          ? existing.inputDigest !== inputDigest
          : existing.text !== text ||
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
    if (!resident.driver) {
      this.transfer(id, {
        id: requestId,
        provider: resident.snapshot.session.harness,
        text,
        attachments,
      })
      return request
    }
    request.inputDigest = inputDigest
    request.attachments = this.assets.retainPrompt(request.attachments)
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

  authorizeAgent(
    id: string,
    bindingId: string,
    action: "read" | "delegate" = "read"
  ): void {
    const resident = this.require(id)
    if (
      this.control(resident).activeBindingId !== bindingId ||
      !resident.driver ||
      resident.snapshot.session.status !== "running"
    )
      throw new Error(
        "This provider no longer owns an active turn in this conversation"
      )
    // Provider-specific modes have no cross-provider ordering. Do not silently
    // grant another provider its defaults from a restricted parent mode.
    if (action === "delegate" && resident.snapshot.session.currentMode !== null)
      throw new Error(
        "Delegate from the desk when the parent uses a provider-specific mode"
      )
  }

  childTasks(id: string) {
    return this.control(this.require(id)).children
  }

  availableProviders(): string[] {
    return (this.dependencies.providers?.() ?? []).filter((provider) =>
      this.dependencies.driver(provider)?.available(this.dependencies.appPath)
    )
  }

  delegate(id: string, input: DelegateInput): Promise<LiveSnapshot> {
    return this.children.delegate(id, input)
  }
  cancelChild(id: string, childId: string): LiveSnapshot {
    return this.children.cancelChild(id, childId)
  }

  async mergeFork(id: string, mergeId: string): Promise<LiveSnapshot> {
    z.string().uuid().parse(mergeId)
    const source = this.require(id)
    this.flush(source)
    const ancestry = this.control(source).ancestry
    if (ancestry?.kind !== "fork")
      throw new Error("Only a fork can send findings back to its parent")
    const parent = this.require(ancestry.parentId)
    const existing = this.control(parent).merges.find(
      (merge) => merge.id === mergeId
    )
    if (existing) {
      if (existing.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    if (
      source.snapshot.session.status === "running" ||
      source.snapshot.requests.some(
        (request) =>
          request.status === "queued" || request.status === "dispatching"
      )
    )
      throw new Error(
        "Wait for the fork's current turn to finish before transferring findings"
      )
    if (
      !source.snapshot.requests.some(
        (request) => request.status === "completed"
      )
    )
      throw new Error("The fork has no completed findings yet")
    const captured = source.snapshot
    const manifest = await prepareLiveContext({
      snapshot: captured,
      root: join(this.dependencies.root, "context"),
      fromBlock: 0,
      includesBase: false,
    })
    const control = this.control(parent)
    const concurrent = control.merges.find((merge) => merge.id === mergeId)
    if (concurrent) {
      if (concurrent.sourceId !== id)
        throw new Error("This merge ID belongs to another fork")
      return parent.snapshot
    }
    const previous = parent.snapshot
    parent.snapshot = {
      ...previous,
      control: {
        ...control,
        merges: [
          ...control.merges,
          {
            id: mergeId,
            sourceId: id,
            sourceRevision: captured.revision,
            manifest,
            status: "pending",
          },
        ],
      },
    }
    try {
      this.flush(parent)
    } catch (error) {
      parent.snapshot = previous
      throw error
    }
    return parent.snapshot
  }

  fork(id: string, input: ForkInput): LiveSnapshot {
    const command = ForkInputSchema.parse(input)
    const parent = this.require(id)
    this.flush(parent)
    const source = parent.snapshot
    const point = JSON.stringify(command.point)
    const existing = this.load(command.id)
    if (existing) {
      if (
        existing.snapshot.control?.ancestry?.parentId !== id ||
        existing.snapshot.control.ancestry.point !== point ||
        (existing.snapshot.control.ancestry.provider ??
          existing.snapshot.session.harness) !== command.provider
      )
        throw new Error("This fork ID belongs to another source point")
      return existing.snapshot
    }
    let nativeFork: NonNullable<ConversationControl["ancestry"]>["nativeFork"]
    let entries = source.base?.entries ?? []
    if (command.point.kind === "run") {
      const requestId = command.point.requestId
      const request = source.requests.find(
        (candidate) => candidate.id === requestId
      )
      if (request?.status !== "completed")
        throw new Error("Fork from a completed answer")
      const binding = source.control?.bindings.find(
        (candidate) => candidate.id === request.nativeRun?.bindingId
      )
      if (
        binding?.nativeId &&
        request.nativeRun &&
        binding.provider === command.provider &&
        this.dependencies.driver(command.provider)?.canForkAtRun
      )
        nativeFork = {
          provider: binding.provider,
          nativeId: binding.nativeId,
          runId: request.nativeRun.runId,
        }
      const start = source.blocks.findIndex(
        (block) => block.type === "user" && block.requestId === requestId
      )
      if (start < 0)
        throw new Error("The source turn is not present in this capture")
      const next = source.blocks.findIndex(
        (block, index) => index > start && block.type === "user"
      )
      entries = [
        ...entries,
        ...liveEntries(
          source.blocks.slice(0, next < 0 ? source.blocks.length : next)
        ),
      ]
    } else {
      const base = source.base
      if (!base || nativeRevision(base) !== command.point.revision)
        throw new Error(
          "The source history changed. Reload it before choosing a fork point."
        )
      const index = command.point.index - base.start
      if (
        index < 0 ||
        index >= base.entries.length ||
        base.entries[index]?.kind !== "assistant"
      )
        throw new Error(
          "Choose an answer present in the captured native history"
        )
      entries = base.entries.slice(0, index + 1)
    }
    const snapshot: LiveSnapshot = {
      session: {
        ...source.session,
        id: command.id,
        harness: command.provider,
        nativeId: undefined,
        title: source.session.title ? `${source.session.title} — fork` : "Fork",
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: null,
        configOptions: [],
        lastStop: undefined,
        error: undefined,
      },
      revision: 0,
      createdAt: Date.now(),
      blocks: [],
      requests: [],
      permissions: [],
      base: {
        ref: source.base?.ref ?? {
          path: id,
          nativeId: id,
          harness: source.session.harness,
          cwd: source.session.cwd,
        },
        entries,
        start: source.base?.start ?? 0,
        total: entries.length,
        hasEarlier: source.base?.hasEarlier ?? false,
      },
      control: {
        children: [],
        merges: [],
        ancestry: {
          kind: "fork",
          nativeFork,
          provider: command.provider,
          parentId: id,
          sourceRevision: source.revision,
          point,
        },
        activeBindingId: command.id,
        bindings: [],
        transfers: [],
      },
    }
    const journal = new LiveJournal(this.dependencies.root, command.id)
    try {
      journal.commit(snapshot)
    } catch (error) {
      journal.close()
      throw error
    }
    this.records.set(command.id, {
      snapshot,
      journalSnapshot: snapshot,
      journal,
      driver: null,
      connections: new Map(),
      transferring: false,
      generation: 0,
      opening: false,
      pendingCharacters: 0,
      updates: [],
      timer: null,
    })
    return snapshot
  }

  transfer(id: string, input: TransferInput): LiveSnapshot {
    return this.transfers.accept(id, input)
  }

  private control(resident: Resident): ConversationControl {
    return (
      resident.snapshot.control ?? {
        children: [],
        merges: [],
        activeBindingId: resident.snapshot.session.id,
        bindings: [
          {
            id: resident.snapshot.session.id,
            provider: resident.snapshot.session.harness,
            nativeId: resident.snapshot.session.nativeId,
            path: resident.snapshot.threadPath,
            coveredBlocks: resident.snapshot.blocks.length,
            includesBase: true,
          },
        ],
        transfers: [],
      }
    )
  }

  private updateBinding(resident: Resident, session: LiveSessionState): void {
    const control = this.control(resident)
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...control,
        bindings: control.bindings.map((binding) =>
          binding.id === control.activeBindingId
            ? { ...binding, nativeId: session.nativeId ?? binding.nativeId }
            : binding
        ),
      },
    }
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
    if (this.transfers.pending(resident))
      throw new Error(
        "Wait for the provider switch before loading earlier history"
      )
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
    if (this.transfers.pending(resident))
      throw new Error("History loading was superseded by a provider switch")
    // Another caller may already have prepended this page.
    if (
      earlier &&
      resident.snapshot.base === base &&
      earlier.total >= base.total &&
      earlier.start < base.start
    ) {
      resident.snapshot = {
        ...resident.snapshot,
        control: {
          ...this.control(resident),
          bindings: this.control(resident).bindings.map((binding) => ({
            ...binding,
            includesBase: false,
          })),
        },
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

  private checkpointIdle(resident: Resident): void {
    const bindingId = this.control(resident).activeBindingId
    const path = resident.snapshot.threadPath
    const blocks = resident.snapshot.blocks
    if (
      !path ||
      resident.snapshot.session.status !== "ready" ||
      !this.dependencies.checkpoint
    )
      return
    void this.dependencies
      .checkpoint(path)
      .then((checkpoint) => {
        if (
          !checkpoint ||
          !this.records.has(resident.snapshot.session.id) ||
          this.control(resident).activeBindingId !== bindingId ||
          resident.snapshot.session.status !== "ready" ||
          resident.snapshot.blocks !== blocks ||
          resident.snapshot.threadPath !== path ||
          resident.snapshot.requests.some(
            (request) => request.status === "dispatching"
          )
        )
          return
        const control = this.control(resident)
        resident.snapshot = {
          ...resident.snapshot,
          control: {
            ...control,
            bindings: control.bindings.map((binding) =>
              binding.id === bindingId
                ? { ...binding, checkpoint, coveredBlocks: blocks.length }
                : binding
            ),
          },
        }
        this.flush(resident)
      })
      .catch(() => {})
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
    resident.snapshot = {
      ...resident.snapshot,
      threadPath: path,
      control: {
        ...this.control(resident),
        bindings: this.control(resident).bindings.map((binding) =>
          binding.id === this.control(resident).activeBindingId
            ? { ...binding, path }
            : binding
        ),
      },
    }
    this.flush(resident)
    this.checkpointIdle(resident)
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
    await resident.driver.permission(
      this.control(resident).activeBindingId,
      requestId,
      response
    )
    resident.snapshot = {
      ...resident.snapshot,
      permissions: resident.snapshot.permissions.filter(
        (candidate) => candidate.id !== requestId
      ),
    }
    this.flush(resident)
  }

  async cancelRequest(id: string, requestId: string): Promise<void> {
    const resident = this.require(id)
    const request = resident.snapshot.requests.find(
      (request) => request.id === requestId
    )
    if (request?.status === "dispatching") {
      await resident.driver?.cancel(this.control(resident).activeBindingId)
      return
    }
    const pending = this.transfers.pending(resident)
    if (pending?.input.id === requestId) {
      if (pending.state.kind === "preparing") resident.generation += 1
      this.transfers.save(resident, {
        ...pending,
        state: { kind: "failed", error: "The remote request was canceled" },
      })
    }
    if (request?.status === "queued") {
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((candidate) =>
          candidate.id === requestId
            ? {
                ...candidate,
                status: "interrupted",
                error: "The remote request was canceled",
              }
            : candidate
        ),
      }
      this.flush(resident)
    }
    this.drain(resident)
  }

  async cancel(id: string): Promise<void> {
    const resident = this.require(id)
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued")
        this.children.cancelChild(id, child.id)
    await resident.driver?.cancel(this.control(resident).activeBindingId)
  }
  async setMode(id: string, modeId: string): Promise<void> {
    const resident = this.require(id)
    if (!resident.driver) throw new Error("The provider is disconnected")
    await resident.driver.setMode(
      this.control(resident).activeBindingId,
      modeId
    )
  }
  close(id: string): void {
    const resident = this.require(id)
    for (const child of this.control(resident).children)
      if (child.delivery === "pending" || child.delivery === "queued")
        this.children.cancelChild(id, child.id)
    resident.generation += 1
    const pending = this.transfers.pending(resident)
    if (pending)
      this.transfers.save(resident, {
        ...pending,
        state: {
          kind: "failed",
          error: "The conversation was closed before the switch completed",
        },
      })
    for (const [bindingId, connection] of resident.connections)
      connection.driver.close(bindingId)
    resident.connections.clear()
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
      for (const [bindingId, connection] of resident.connections)
        connection.driver.close(bindingId)
      if (resident.opening)
        driver?.close(this.control(resident).activeBindingId)
      this.flush(resident)
      resident.journal.close()
    }
    this.records.clear()
  }

  private drain(resident: Resident): void {
    this.children.deliver(resident)
    if (this.transfers.pending(resident)) {
      void this.transfers.perform(resident)
      return
    }
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
    const control = this.control(resident)
    const pendingMerges = control.merges.filter(
      (merge) => merge.status === "pending"
    )
    const current = {
      ...request,
      status: "dispatching" as const,
      context: [
        ...(request.context ?? []),
        ...pendingMerges.map((merge) => merge.manifest),
      ],
    }
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...control,
        children: control.children.map((child) =>
          child.deliveryId === request.id && child.delivery === "queued"
            ? { ...child, delivery: "delivered" }
            : child
        ),
        merges: control.merges.map((merge) =>
          merge.status === "pending" ? { ...merge, status: "consumed" } : merge
        ),
      },
      requests: resident.snapshot.requests.map((candidate) =>
        candidate.id === request.id ? current : candidate
      ),
    }
    const text = request.displayText ?? resident.displayPrompt ?? request.text
    resident.displayPrompt = undefined
    if (text || request.attachments.length)
      resident.updates.push({
        kind: "user",
        provider: resident.snapshot.session.harness,
        requestId: request.id,
        contextFiles: current.context.map((manifest) => manifest.file),
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
      .prompt(
        this.control(resident).activeBindingId,
        current.context.reduce(
          (text, manifest) => contextPrompt(manifest, text),
          request.text
        ),
        request.attachments
      )
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
        control:
          previous.control !== snapshot.control ? snapshot.control : undefined,
        base: previous.base !== snapshot.base ? snapshot.base : undefined,
        threadPath:
          previous.threadPath !== snapshot.threadPath
            ? (snapshot.threadPath ?? null)
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
    if (
      previous.session.status === "running" &&
      snapshot.session.status === "ready"
    )
      this.checkpointIdle(resident)
    if (
      previous.requests !== snapshot.requests ||
      previous.permissions !== snapshot.permissions ||
      previous.session.status !== snapshot.session.status
    )
      this.children.settle(resident)
  }

  private storageFailed(resident: Resident, boundary: FailureBoundary): void {
    if (resident.storageFault) return
    resident.storageFault = true
    this.dependencies.emit({
      type: "notice",
      level: "error",
      message: `The conversation could not be saved. The provider is being stopped; buffered output is retained in memory. ${errorMessage(boundary)}`,
    })
    void resident.driver
      ?.cancel(this.control(resident).activeBindingId)
      .catch(() => {})
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
      control: previous.control
        ? {
            ...previous.control,
            transfers: previous.control.transfers.map((transfer) =>
              transfer.state.kind === "preparing" ||
              transfer.state.kind === "queued"
                ? {
                    ...transfer,
                    state: {
                      kind: "failed" as const,
                      error:
                        "The host restarted before the provider switch was activated. Submit a new switch to retry.",
                    },
                  }
                : transfer
            ),
          }
        : undefined,
      session: {
        ...previous.session,
        status:
          previous.session.status === "closed"
            ? "closed"
            : previous.session.status === "ready"
              ? "ready"
              : "failed",
        connection: "disconnected",
        error:
          previous.session.status === "running"
            ? "The host restarted before completion was confirmed. Saved output is available."
            : undefined,
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
      connections: new Map(),
      transferring: false,
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
    this.children.recover(resident)
    return resident
  }
}

function nativeRevision(page: ThreadPage): string {
  return JSON.stringify([page.ref.revision, page.ref.bytes, page.ref.updatedAt])
}
