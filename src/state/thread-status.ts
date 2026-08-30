import { toast } from "sonner"
import type { ThreadRef, ThreadRunState } from "@/lib/types"
import { releaseQueuedReply } from "@/state/thread-queue"
import type { AttentionByPath, ThreadsState } from "@/state/thread-state"
import { threadsStore } from "@/state/thread-store"

export type ThreadStatus =
  | { kind: "idle" }
  | { kind: "working"; since: number; detail?: string }
  | { kind: "needs-permission"; since: number; detail?: string }
  | { kind: "failed"; at: number; detail?: string }
  | { kind: "review"; at: number; unread: boolean }
  | { kind: "observed" }
  | { kind: "external-open" }
  | { kind: "external-active" }

const IDLE_STATUS: ThreadStatus = { kind: "idle" }
const OBSERVED_STATUS: ThreadStatus = { kind: "observed" }
const EXTERNAL_OPEN_STATUS: ThreadStatus = { kind: "external-open" }
const EXTERNAL_ACTIVE_STATUS: ThreadStatus = { kind: "external-active" }

export function threadStatusPriority(status: ThreadStatus): number {
  switch (status.kind) {
    case "needs-permission":
      return 5
    case "failed":
      return 4
    case "review":
      return status.unread ? 3 : 0
    case "working":
      return 2
    case "observed":
    case "external-active":
      return 1
    case "external-open":
    case "idle":
      return 0
  }
}

export function threadStatus(
  ref: ThreadRef,
  state: ThreadsState = threadsStore.get()
): ThreadStatus {
  const attention = state.attention[ref.path]
  if (attention) return attention
  const working = state.working[ref.path]
  if (working) return working
  const external = state.externalActivity[ref.path]
  if (external?.status === "needs-input")
    return {
      kind: "needs-permission",
      since: external.since,
      detail: external.detail,
    }
  if (external?.status === "active") return EXTERNAL_ACTIVE_STATUS
  if (ref.active === true) return EXTERNAL_ACTIVE_STATUS
  if (ref.locked)
    return state.observed[ref.path]
      ? EXTERNAL_ACTIVE_STATUS
      : EXTERNAL_OPEN_STATUS
  if (ref.active === false) return IDLE_STATUS
  return state.observed[ref.path] ? OBSERVED_STATUS : IDLE_STATUS
}

export const OBSERVED_IDLE_MS = 60_000
const observedTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function clearObserved(path: string) {
  const timer = observedTimers.get(path)
  if (timer) clearTimeout(timer)
  observedTimers.delete(path)
  if (!threadsStore.get().observed[path]) return
  const observed = { ...threadsStore.get().observed }
  delete observed[path]
  threadsStore.set({ observed })
}

export function markObserved(path: string, duration = OBSERVED_IDLE_MS) {
  if (threadsStore.get().working[path]) return
  if (!threadsStore.get().observed[path]) {
    threadsStore.set({
      observed: { ...threadsStore.get().observed, [path]: true },
    })
  }
  const held = observedTimers.get(path)
  if (held) clearTimeout(held)
  observedTimers.delete(path)
  observedTimers.set(
    path,
    setTimeout(() => clearObserved(path), Math.max(1, duration))
  )
}

export function recentThreadActivityDuration(
  ref: ThreadRef,
  now = Date.now()
): number | null {
  if (ref.active !== undefined || ref.locked || !ref.updatedAt) return null
  const elapsed = now - Date.parse(ref.updatedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < OBSERVED_IDLE_MS
    ? OBSERVED_IDLE_MS - elapsed
    : null
}

export function seedRecentThreadActivity(
  refs: ThreadRef[],
  now = Date.now()
): void {
  for (const ref of refs) {
    const duration = recentThreadActivityDuration(ref, now)
    if (duration !== null) markObserved(ref.path, duration)
  }
}

export function activeThreadRefs(
  refs: ThreadRef[],
  state: ThreadsState = threadsStore.get()
): ThreadRef[] {
  return refs
    .filter((ref) => {
      const status = threadStatus(ref, state)
      return (
        status.kind === "working" ||
        status.kind === "needs-permission" ||
        status.kind === "observed" ||
        status.kind === "external-active"
      )
    })
    .sort((left, right) => {
      const priority =
        threadStatusPriority(threadStatus(right, state)) -
        threadStatusPriority(threadStatus(left, state))
      return priority || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
    })
}

/** A native run started, finished, or failed, on any thread. */
export function setThreadRunning(path: string, active: boolean) {
  const current = threadsStore.get().working[path]
  if (Boolean(current) === active) return
  if (active) clearObserved(path)
  const working = { ...threadsStore.get().working }
  if (active) working[path] = { kind: "working", since: Date.now() }
  else delete working[path]
  threadsStore.set({ working })
}

export function setThreadWorkDetail(path: string, detail?: string) {
  const current = threadsStore.get().working[path]
  if (!current || current.detail === detail) return
  threadsStore.set({
    working: {
      ...threadsStore.get().working,
      [path]: { ...current, detail },
    },
  })
}

export function setThreadAttention(
  path: string,
  attention: AttentionByPath[string] | null
) {
  const current = threadsStore.get().attention[path]
  if (!current && !attention) return
  const next = { ...threadsStore.get().attention }
  if (attention) next[path] = attention
  else delete next[path]
  threadsStore.set({ attention: next })
}

export function markThreadReviewed(path: string) {
  if (threadsStore.get().attention[path]?.kind !== "review") return
  setThreadAttention(path, null)
}

export function applyThreadRun(run: ThreadRunState) {
  const { viewing, queuedReplies } = threadsStore.get()
  const queue = queuedReplies[run.path]
  setThreadRunning(run.path, run.status === "running")
  if (run.status === "running") setThreadAttention(run.path, null)
  else if (run.status === "done" && !queue)
    setThreadAttention(
      run.path,
      viewing?.ref.path === run.path
        ? null
        : { kind: "review", at: Date.now(), unread: true }
    )
  else if (run.status === "failed")
    setThreadAttention(run.path, {
      kind: "failed",
      at: Date.now(),
      detail: run.error,
    })
  else setThreadAttention(run.path, null)
  if (viewing && viewing.ref.path === run.path) threadsStore.set({ run })
  if (run.status === "failed" && run.error) toast.error(run.error)
  if (run.status !== "running") releaseQueuedReply(run.path)
}
