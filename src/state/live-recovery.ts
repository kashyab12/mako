import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveBatch, LiveSnapshot, LiveSummary } from "@/lib/types"
import { acpStore, replaceAcpConversation } from "@/state/acp-state"
import { syncThreadStatus } from "@/state/acp-live"
import { reduceLiveUpdates } from "../../electron/contracts/live-content"
import { projectLive } from "@/state/live-projection"
import { toast } from "sonner"

const fetching = new Map<string, Promise<void>>()
const pending = new Map<string, LiveBatch[]>()

export function applyLiveSnapshot(snapshot: LiveSnapshot): void {
  const id = snapshot.session.id
  const existing = acpStore.get().conversations[id]
  if (existing?.hydrated && (existing.revision ?? 0) > snapshot.revision) return
  replaceAcpConversation(id, {
    key: id,
    draftKey: existing?.draftKey ?? id,
    harness: snapshot.session.harness,
    cwd: snapshot.session.cwd,
    title: snapshot.session.title,
    threadPath: snapshot.threadPath,
    createdAt: snapshot.createdAt,
    updatedAt: Date.now(),
    kind: "live",
    session: snapshot.session,
    nativePaths: snapshot.control?.bindings.flatMap((binding) =>
      binding.path ? [binding.path] : []
    ),
    control: snapshot.control,
    requests: snapshot.requests,
    base: snapshot.base,
    blocks: snapshot.blocks,
    revision: snapshot.revision,
    hydrated: true,
    projection: projectLive(snapshot, existing?.projection),
    permission: snapshot.permissions[0] ?? null,
    queued: snapshot.requests.filter((request) => request.status === "queued"),
    hiddenUserPrompt: null,
    sending: false,
    canceling: false,
  })
  const restored = acpStore.get().conversations[id]
  if (restored?.kind === "live")
    syncThreadStatus(
      restored,
      existing?.kind === "live" ? existing.session.status : "starting"
    )
  const buffered = pending.get(id) ?? []
  pending.delete(id)
  for (const batch of buffered) applyLiveBatch(batch)
}

export async function hydrateLive(id: string): Promise<void> {
  if (!hasBridge()) return
  const existing = fetching.get(id)
  if (existing) return existing
  let restored = false
  const fetch = getMako()
    .liveSnapshot(id)
    .then((snapshot) => {
      restored = true
      if (snapshot) applyLiveSnapshot(snapshot)
      else pending.delete(id)
    })
    .catch((error) => {
      toast.error("The live conversation could not be restored", {
        description: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      fetching.delete(id)
      if (restored && pending.get(id)?.length)
        queueMicrotask(() => {
          void hydrateLive(id)
        })
    })
  fetching.set(id, fetch)
  return fetch
}

export function applyLiveBatch(batch: LiveBatch): void {
  const current = acpStore.get().conversations[batch.id]
  if (
    !current?.hydrated ||
    current.kind !== "live" ||
    batch.revision > (current.revision ?? 0) + 1
  ) {
    // A bounded buffer is only an optimization. The host snapshot remains authoritative.
    const buffered = pending.get(batch.id) ?? []
    pending.set(batch.id, [...buffered.slice(-127), batch])
    void hydrateLive(batch.id)
    return
  }
  if (batch.revision <= (current.revision ?? 0)) return
  const session = batch.session ?? current.session
  const blocks = reduceLiveUpdates(current.blocks, batch.updates)
  const base = batch.base === undefined ? (current.base ?? null) : batch.base
  replaceAcpConversation(batch.id, {
    ...current,
    control: batch.control ?? current.control,
    nativePaths: batch.control
      ? batch.control.bindings.flatMap((binding) =>
          binding.path ? [binding.path] : []
        )
      : current.nativePaths,
    harness: session.harness,
    requests: batch.requests ?? current.requests,
    blocks,
    session,
    revision: batch.revision,
    base,
    threadPath:
      batch.threadPath === undefined
        ? current.threadPath
        : (batch.threadPath ?? undefined),
    sending: batch.session ? false : current.sending,
    canceling: session.status === "running" ? current.canceling : false,
    permission: batch.permissions
      ? (batch.permissions[0] ?? null)
      : current.permission,
    queued: batch.requests
      ? batch.requests.filter((request) => request.status === "queued")
      : current.queued,
    projection: projectLive({ blocks, base, session }, current.projection),
    updatedAt: Date.now(),
  })
  const next = acpStore.get().conversations[batch.id]
  if (
    next?.kind === "live" &&
    (batch.session || batch.permissions || batch.requests)
  )
    syncThreadStatus(next, current.session.status)
}

export function hydrateLiveSummaries(summaries: LiveSummary[]): void {
  for (const summary of summaries) {
    if (acpStore.get().conversations[summary.session.id]?.hydrated) continue
    replaceAcpConversation(summary.session.id, {
      kind: "live",
      key: summary.session.id,
      draftKey: summary.session.id,
      session: summary.session,
      harness: summary.session.harness,
      cwd: summary.session.cwd,
      title: summary.session.title,
      nativePaths: summary.nativePaths,
      threadPath: summary.threadPath,
      revision: summary.revision,
      hydrated: false,
      createdAt: summary.createdAt,
      updatedAt: summary.createdAt,
      blocks: [],
      queued: [],
      hiddenUserPrompt: null,
      permission: null,
      sending: false,
      canceling: false,
    })
    const restored = acpStore.get().conversations[summary.session.id]
    if (restored?.kind === "live") syncThreadStatus(restored, "starting")
  }
  const newest = summaries.toSorted((a, b) => b.createdAt - a.createdAt)[0]
  if (newest && !acpStore.get().activeKey) {
    acpStore.set({ activeKey: newest.session.id })
    void hydrateLive(newest.session.id)
  }
}

export async function loadEarlierLive(id: string): Promise<void> {
  const snapshot = await getMako().liveEarlier(id)
  applyLiveSnapshot(snapshot)
}
