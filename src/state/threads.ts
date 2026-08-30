import { getMako, hasBridge } from "@/lib/bridge"
import type { ThreadRef } from "@/lib/types"
import { bindQueuedReplySender } from "@/state/thread-queue"
import {
  takePendingThread,
  threadContinuationActions,
  withConversion,
} from "@/state/thread-continuation"
import {
  applyThreadRun,
  clearObserved,
  markObserved,
  markThreadReviewed,
  OBSERVED_IDLE_MS,
  setThreadAttention,
  setThreadRunning,
  setThreadWorkDetail,
  threadStatus,
  threadStatusPriority,
} from "@/state/thread-status"
import type { ThreadStatus } from "@/state/thread-status"
import {
  canResumeInteractively,
  initializeComposerTuning,
  setComposerHarness,
  setComposerTuning,
} from "@/state/thread-tuning"
import {
  applyThreadEntries,
  rememberThread,
  threadViewingActions,
} from "@/state/thread-viewing"
import { threadsStore, useThreads } from "@/state/thread-store"

interface ThreadCatalog {
  ready: boolean
  threads: ThreadRef[]
}

type ThreadCatalogResponse = ThreadCatalog | ThreadRef[]

function unavailableThreadCatalog(): ThreadCatalog {
  return { ready: false, threads: [] }
}

function normalizeThreadCatalog(
  response: ThreadCatalogResponse
): ThreadCatalog {
  return Array.isArray(response) ? { ready: true, threads: response } : response
}

export {
  threadsStore,
  useThreads,
  applyThreadEntries,
  applyThreadRun,
  canResumeInteractively,
  initializeComposerTuning,
  markThreadReviewed,
  setComposerHarness,
  setComposerTuning,
  setThreadAttention,
  setThreadRunning,
  setThreadWorkDetail,
  threadStatus,
  threadStatusPriority,
  withConversion,
}
export type { ThreadStatus }

let knownPaths = new Set<string>()

export function applyThreadRef(ref: ThreadRef) {
  const current = threadsStore.get().threads
  const at = current.findIndex((entry) => entry.path === ref.path)
  const previous = at === -1 ? undefined : current[at]
  const updatedAt = ref.updatedAt ? Date.parse(ref.updatedAt) : Number.NaN
  const recentlyAdded =
    at === -1 &&
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt < OBSERVED_IDLE_MS
  const advanced = Boolean(
    previous &&
      ((ref.bytes ?? 0) > (previous.bytes ?? 0) ||
        ref.updatedAt !== previous.updatedAt)
  )
  if (ref.active !== undefined) clearObserved(ref.path)
  else if (recentlyAdded || advanced) markObserved(ref.path)
  const next =
    at === -1
      ? [...current, ref]
      : current.map((entry, index) => (index === at ? ref : entry))
  next.sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  )
  applyThreads(next)
  const viewing = threadsStore.get().viewing
  if (viewing?.ref.path === ref.path) {
    const updated = { ...viewing, ref }
    threadsStore.set({ viewing: updated })
    rememberThread(updated)
  }
}

export function applyThreadRemoved(path: string) {
  clearObserved(path)
  setThreadRunning(path, false)
  setThreadAttention(path, null)
  applyThreads(threadsStore.get().threads.filter((entry) => entry.path !== path))
}

export function uniqueThreadRefs(list: ThreadRef[]) {
  const byIdentity = new Map<string, ThreadRef>()
  for (const ref of list) {
    const key = `${ref.harness}:${ref.nativeId}`
    const held = byIdentity.get(key)
    if (
      !held ||
      (held.archived && !ref.archived) ||
      (held.archived === ref.archived &&
        (ref.updatedAt ?? "") > (held.updatedAt ?? ""))
    )
      byIdentity.set(key, ref)
  }
  return [...byIdentity.values()].sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  )
}

export function applyThreads(list: ThreadRef[], loaded = true) {
  const unique = uniqueThreadRefs(list)
  threadsStore.set({ threads: unique, loaded })
  const candidate = takePendingThread(unique, knownPaths)
  if (candidate) void threadViewingActions.view(candidate)
  knownPaths = new Set(unique.map((ref) => ref.path))
}

let focusRefetch = false

const threadCatalogActions = {
  /** Re-ask on window focus: cheap, and heals any missed push for good. */
  watchFocus() {
    if (focusRefetch || globalThis.window === undefined) return
    focusRefetch = true
    window.addEventListener("focus", () => void threadCatalogActions.load())
  },

  async load() {
    if (!hasBridge()) return
    const [raw, resumable, targets, acpable]: [
      ThreadCatalogResponse,
      string[],
      string[],
      string[],
    ] = await Promise.all([
      getMako().threads().catch(unavailableThreadCatalog),
      getMako()
        .resumableHarnesses()
        .catch((): string[] => []),
      getMako()
        .continueTargets()
        .catch((): string[] => []),
      getMako()
        .acpHarnesses()
        .catch((): string[] => []),
    ])
    // An engine one vintage older answers with a bare array; treat it as
    // ready rather than spinning forever against the shape difference.
    const result = normalizeThreadCatalog(raw)
    threadsStore.set({ resumable, targets, acpable })
    applyThreads(result.threads, result.ready)
    // The catalog scans for a moment at boot, and its "here is the list"
    // push can fire while the window is still loading — a lossy first
    // handshake. Retrying until the host says ready is what makes the rail
    // reliable rather than usually-fine.
    if (!result.ready) {
      setTimeout(() => void threadCatalogActions.load(), 1500)
    }
  },
}

export const threads = {
  ...threadCatalogActions,
  ...threadViewingActions,
  ...threadContinuationActions,
}

bindQueuedReplySender(threadContinuationActions.reply)
