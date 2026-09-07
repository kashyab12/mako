import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { TransferInputSchema } from "./contracts/conversation-control.js"
import type {
  TransferInput,
  ContextTransfer,
} from "./contracts/conversation-control.js"
import type { LiveSnapshot } from "./shared.js"
import { LiveRequestSchema } from "./live-journal.js"
import { prepareLiveContext } from "./live-context.js"
import { errorMessage } from "./live-runtime.js"
import type {
  LiveAccess,
  Resident,
  ProviderConnection,
} from "./live-runtime.js"

/** Durable switch acceptance and provider preparation, separate from token ingestion. */
export class LiveTransfers {
  private readonly host: LiveAccess
  constructor(host: LiveAccess) {
    this.host = host
  }
  accept(id: string, input: TransferInput): LiveSnapshot {
    const command = TransferInputSchema.parse(input)
    const inputDigest = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex")
    const resident = this.host.require(id)
    const control = this.host.control(resident)
    const existing = control.transfers.find(
      (transfer) => transfer.input.id === command.id
    )
    if (existing) {
      if (
        existing.inputDigest
          ? existing.inputDigest !== inputDigest
          : JSON.stringify(existing.input) !== JSON.stringify(command)
      )
        throw new Error(
          "This transfer ID was already used with different content"
        )
      return resident.snapshot
    }
    if (!command.text.trim() && !command.attachments.length)
      throw new Error("A transfer needs a request or an attachment")
    if (this.pending(resident))
      throw new Error("A provider switch is already pending")
    if (
      resident.snapshot.requests.some((request) => request.status === "queued")
    )
      throw new Error(
        "Send or remove queued messages before switching providers"
      )
    if (resident.snapshot.requests.some((request) => request.id === command.id))
      throw new Error("That request ID already exists")
    const driver = this.host.dependencies.driver(command.provider)
    if (!driver?.available(this.host.dependencies.appPath))
      throw new Error(
        `${command.provider} has no available interactive transport`
      )
    command.attachments = this.host.retainAttachments(command.attachments)
    const previous = resident.snapshot
    resident.snapshot = {
      ...previous,
      control: {
        ...control,
        transfers: [
          ...control.transfers,
          {
            input: command,
            inputDigest,
            createdAt: Date.now(),
            state: { kind: "queued" },
          },
        ],
      },
    }
    try {
      this.host.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    void this.perform(resident)
    return resident.snapshot
  }

  pending(resident: Resident): ContextTransfer | undefined {
    return this.host
      .control(resident)
      .transfers.find(
        (transfer) =>
          transfer.state.kind === "queued" ||
          transfer.state.kind === "preparing"
      )
  }

  save(resident: Resident, transfer: ContextTransfer): void {
    const control = this.host.control(resident)
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...control,
        transfers: control.transfers.map((candidate) =>
          candidate.input.id === transfer.input.id ? transfer : candidate
        ),
      },
    }
    this.host.flush(resident)
  }

  async perform(resident: Resident): Promise<void> {
    const transfer = this.pending(resident)
    if (
      !transfer ||
      resident.transferring ||
      resident.opening ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
    )
      return
    resident.transferring = true
    const generation = resident.generation
    let prepared: ProviderConnection | null = null
    let preparedId: string | null = null
    try {
      this.save(resident, { ...transfer, state: { kind: "preparing" } })
      const source = resident.snapshot
      const control = this.host.control(resident)
      const bindings = control.bindings.map((binding) =>
        binding.id === control.activeBindingId && resident.driver
          ? {
              ...binding,
              coveredBlocks: source.blocks.length,
              includesBase: binding.includesBase,
            }
          : binding
      )
      // Reuse only a live, idle connection with identical launch settings. A dormant
      // native file may have changed outside Mako; a fresh full handoff is the safe fallback.
      let prior = bindings.find(
        (binding) =>
          binding.provider === transfer.input.provider &&
          JSON.stringify(binding.tuning) ===
            JSON.stringify(transfer.input.tuning) &&
          resident.connections.get(binding.id)?.session.status === "ready"
      )
      if (
        !prior &&
        this.host.dependencies.driver(transfer.input.provider)?.canResume
      ) {
        for (const binding of [...bindings].reverse()) {
          if (
            binding.provider === transfer.input.provider &&
            JSON.stringify(binding.tuning) ===
              JSON.stringify(transfer.input.tuning) &&
            (await this.host.dependencies.canResume?.(binding))
          ) {
            prior = binding
            break
          }
        }
      }
      const nativeFork =
        !bindings.length &&
        control.ancestry?.nativeFork?.provider === transfer.input.provider &&
        this.host.dependencies.driver(transfer.input.provider)?.canForkAtRun
          ? control.ancestry.nativeFork
          : undefined
      const manifest = await prepareLiveContext({
        snapshot: source,
        root: join(this.host.dependencies.root, "context"),
        fromBlock: prior?.coveredBlocks ?? 0,
        includesBase: !nativeFork && !prior?.includesBase,
      })
      if (resident.generation !== generation) return
      const driver = this.host.dependencies.driver(transfer.input.provider)
      if (!driver) throw new Error("The destination provider was removed")
      const bindingId = prior?.id ?? randomUUID()
      const connection = prior ? resident.connections.get(prior.id) : undefined
      if (connection) prepared = connection
      else {
        preparedId = bindingId
        this.host.bindingOwners.set(bindingId, source.session.id)
        const session = await driver.start(source.session.cwd, {
          conversationId: bindingId,
          resume: prior?.nativeId,
          fork: nativeFork,
          conversationTools: this.host.dependencies.tools?.(
            bindingId,
            source.session.id
          ),
          title: source.session.title,
          tuning: transfer.input.tuning,
        })
        prepared = { driver, session }
      }
      if (resident.generation !== generation) {
        if (preparedId) {
          prepared.driver.close(preparedId)
          this.host.bindingOwners.delete(preparedId)
        }
        return
      }
      if (
        prepared.session.status !== "ready" ||
        prepared.session.connection !== "connected"
      )
        throw new Error(
          "The destination did not become ready; the source conversation is unchanged"
        )
      const latestBindings = this.host
        .control(resident)
        .bindings.map((binding) => {
          const coverage = bindings.find(
            (candidate) => candidate.id === binding.id
          )
          return coverage
            ? {
                ...binding,
                coveredBlocks: coverage.coveredBlocks,
                includesBase: coverage.includesBase,
              }
            : binding
        })
      const binding = (prior &&
        latestBindings.find((candidate) => candidate.id === prior.id)) ?? {
        id: bindingId,
        provider: transfer.input.provider,
        nativeId: prepared.session.nativeId,
        tuning: transfer.input.tuning,
        coveredBlocks: 0,
        includesBase: false,
      }
      const accepted: ContextTransfer = {
        ...transfer,
        state: { kind: "accepted", bindingId, manifest },
      }
      const previous = resident.snapshot
      const previousDriver = resident.driver
      resident.connections.set(bindingId, prepared)
      resident.driver = prepared.driver
      resident.snapshot = {
        ...previous,
        session: {
          ...prepared.session,
          id: source.session.id,
          title: source.session.title,
        },
        // The base retains its own native identity. The active native path changes independently.
        threadPath: binding.path,
        permissions: [],
        requests: [
          ...previous.requests,
          LiveRequestSchema.parse({
            id: transfer.input.id,
            text: transfer.input.text,
            displayText: transfer.input.text,
            attachments: transfer.input.attachments,
            context: [manifest],
            status: "queued",
          }),
        ],
        control: {
          ...this.host.control(resident),
          activeBindingId: bindingId,
          bindings: (prior ? latestBindings : [...latestBindings, binding]).map(
            (candidate) =>
              candidate.id === bindingId
                ? { ...candidate, includesBase: true }
                : candidate
          ),
          transfers: this.host
            .control(resident)
            .transfers.map((candidate) =>
              candidate.input.id === transfer.input.id ? accepted : candidate
            ),
        },
      }
      try {
        this.host.flush(resident)
      } catch (error) {
        resident.snapshot = previous
        resident.driver = previousDriver
        if (preparedId) resident.connections.delete(preparedId)
        throw error
      }
      preparedId = null
      // Bound idle provider processes. Evicted bindings remain in provenance and
      // receive a complete context package if selected again.
      resident.connections.delete(bindingId)
      resident.connections.set(bindingId, prepared)
      while (resident.connections.size > 4) {
        const oldest = resident.connections.entries().next().value
        if (!oldest) break
        resident.connections.delete(oldest[0])
        oldest[1].driver.close(oldest[0])
      }
    } catch (error) {
      if (preparedId) {
        prepared?.driver.close(preparedId)
        this.host.bindingOwners.delete(preparedId)
      }
      if (resident.generation === generation) {
        try {
          this.save(resident, {
            ...transfer,
            state: { kind: "failed", error: errorMessage({ error }) },
          })
        } catch (failure) {
          this.host.storageFailed(resident, { error: failure })
        }
      }
    } finally {
      resident.transferring = false
      if (!this.pending(resident)) this.host.drain(resident)
    }
  }
}
