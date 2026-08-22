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

export function threadStatus(
  ref: ThreadRef,
  state: ThreadsState = threadsStore.get()
): ThreadStatus {
  const attention = state.attention[ref.path]
  if (attention) return attention
  const working = state.working[ref.path]
  if (working) return working
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

export function markObserved(path: string) {
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
    setTimeout(() => clearObserved(path), OBSERVED_IDLE_MS)
  )
}

/** A native run started, finished, or failed, on any thread. */
export function setThreadRunning(path: string, active: boolean) {
  if (active) clearObserved(path)
  const working = { ...threadsStore.get().working }
  if (active) working[path] ??= { kind: "working", since: Date.now() }
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
  const next = { ...threadsStore.get().attention }
  if (attention) next[path] = attention
  else delete next[path]
  threadsStore.set({ attention: next })
}

export function markThreadReviewed(path: string) {
  const current = threadsStore.get().attention[path]
  if (current?.kind !== "review" || !current.unread) return
  setThreadAttention(path, { ...current, unread: false })
}

export function applyThreadRun(run: ThreadRunState) {
  const { viewing, queuedReplies } = threadsStore.get()
  const queue = queuedReplies[run.path]
  setThreadRunning(run.path, run.status === "running")
  if (run.status === "running") setThreadAttention(run.path, null)
  else if (run.status === "done" && !queue)
    setThreadAttention(run.path, {
      kind: "review",
      at: Date.now(),
      unread: viewing?.ref.path !== run.path,
    })
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
