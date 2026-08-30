import { getMako, hasBridge } from "@/lib/bridge"
import type { Thread, ThreadEntry, ThreadPage, ThreadRef } from "@/lib/types"
import type {
  ThreadsState,
  ViewedThread,
  ViewedThreadEntry,
} from "@/state/thread-state"
import { markObserved, markThreadReviewed } from "@/state/thread-status"
import { threadsStore } from "@/state/thread-store"
import { toast } from "sonner"

/** The composer harness to give back when the viewer closes. */
let harnessBeforeViewing: string | null = null
let viewingGeneration = 0

export function leaveViewerForLive(harness: string) {
  viewingGeneration += 1
  harnessBeforeViewing = null
  threadsStore.set({
    viewing: null,
    opening: null,
    viewingBusy: false,
    run: null,
    composerHarness: harness,
  })
  if (hasBridge()) void getMako().unfollowThread()
}

/**
 * Threads already read this run, so switching back is a paint, not a fetch.
 * Stale-while-revalidate: the cached conversation shows instantly and the
 * fresh read replaces it the moment it lands. Bounded; oldest falls out.
 */
const threadCache = new Map<string, ViewedThread>()
const THREAD_CACHE_MAX = 4
const THREAD_CACHE_BYTES = 24 * 1024 * 1024

function estimatedThreadBytes(thread: ViewedThread): number {
  return Math.min(thread.ref.bytes ?? 0, thread.entries.length * 4096)
}

export function viewedThread(thread: Thread): ViewedThread {
  return {
    ...thread,
    pageStart: 0,
    totalEntries: thread.entries.length,
    hasEarlier: false,
  }
}

function viewedPage(page: ThreadPage): ViewedThread {
  return {
    ref: page.ref,
    entries: page.entries,
    pageStart: page.start,
    totalEntries: page.total,
    hasEarlier: page.hasEarlier,
  }
}

export function rememberThread(thread: ViewedThread) {
  threadCache.delete(thread.ref.path)
  threadCache.set(thread.ref.path, thread)
  let bytes = 0
  for (const cached of threadCache.values()) {
    bytes += estimatedThreadBytes(cached)
  }
  while (
    threadCache.size > 1 &&
    (threadCache.size > THREAD_CACHE_MAX || bytes > THREAD_CACHE_BYTES)
  ) {
    const oldest = threadCache.keys().next().value
    if (!oldest) break
    const removed = threadCache.get(oldest)
    threadCache.delete(oldest)
    if (removed) bytes -= estimatedThreadBytes(removed)
  }
}

export function isOptimisticEcho(entry: ViewedThreadEntry): boolean {
  return entry.kind === "user" && entry.echo === true
}

/** Entries appended — by whatever app is writing — to the viewed thread. */
export function applyThreadEntries(
  path: string,
  entries: ThreadEntry[],
  replace?: boolean,
  replaceFrom?: number
) {
  markObserved(path)
  const { viewing } = threadsStore.get()
  if (!viewing || viewing.ref.path !== path) return
  // The real turn arriving retires its optimistic echo: the reply was
  // painted the instant it was sent, and the file tail is the truth that
  // replaces it rather than doubling it.
  const arrivedUserTexts = new Set(
    entries.filter((entry) => entry.kind === "user").map((entry) => entry.text)
  )
  const absoluteReplaceFrom = replaceFrom ?? 0
  const localReplaceFrom = Math.max(0, absoluteReplaceFrom - viewing.pageStart)
  const incoming =
    replace && absoluteReplaceFrom < viewing.pageStart
      ? entries.slice(viewing.pageStart - absoluteReplaceFrom)
      : entries
  const base = replace
    ? viewing.entries.slice(0, localReplaceFrom)
    : viewing.entries.filter(
        (entry) =>
          !isOptimisticEcho(entry) ||
          !(entry.kind === "user" && arrivedUserTexts.has(entry.text))
      )
  const next: ViewedThread = {
    ...viewing,
    entries: [...base, ...incoming],
    totalEntries: replace
      ? viewing.pageStart + base.length + incoming.length
      : viewing.totalEntries + incoming.length,
  }
  if (replace) {
    next.streamRevision = (viewing.streamRevision ?? 0) + 1
    next.streamReplaceFrom = localReplaceFrom
  }
  threadsStore.set({ viewing: next })
  rememberThread(next)
}

export const threadViewingActions = {
  /** Open a foreign session read-only, translated to the canonical shape. */
  async view(ref: ThreadRef) {
    if (!hasBridge()) return
    const generation = ++viewingGeneration
    markThreadReviewed(ref.path)
    const cached = threadCache.get(ref.path)
    if (cached) {
      // Instant: the last read paints now, the fresh one lands underneath.
      if (harnessBeforeViewing === null) {
        harnessBeforeViewing = threadsStore.get().composerHarness
      }
      threadsStore.set({
        viewing: cached,
        opening: null,
        viewingBusy: false,
        run: null,
        composerHarness: cached.ref.harness,
      })
      void getMako()
        .threadRun(ref.path)
        .then((run) => {
          if (
            generation === viewingGeneration &&
            threadsStore.get().viewing?.ref.path === ref.path
          )
            threadsStore.set({ run })
        })
        .catch(() => {})
      // One follow, registered only after the fresh read, from the fresh
      // byte offset. Following from the cached (stale) offset once replayed
      // the overlap into the viewer as duplicates.
      void getMako()
        .pageThread(ref.path)
        .then((fresh) => {
          if (!fresh || generation !== viewingGeneration) return
          const replaced: ViewedThread = {
            ...viewedPage(fresh),
            streamRevision: (cached.streamRevision ?? 0) + 1,
            streamReplaceFrom: 0,
          }
          rememberThread(replaced)
          if (threadsStore.get().viewing?.ref.path === ref.path) {
            threadsStore.set({ viewing: replaced })
            void getMako().followThread(ref.path, replaced.ref.bytes ?? 0)
          }
        })
        .catch(() => {})
      return
    }
    threadsStore.set({ opening: ref, viewingBusy: true, run: null })
    try {
      const [page, run] = await Promise.all([
        getMako().pageThread(ref.path),
        getMako()
          .threadRun(ref.path)
          .catch(() => null),
      ])
      if (generation !== viewingGeneration) return
      if (!page) throw new Error("This session could not be read")
      const thread = viewedPage(page)
      rememberThread(thread)
      // The composer adopts this conversation: its agent picker shows the
      // harness that owns the session, and switching it moves the
      // conversation on the next send. No separate "move" ceremony.
      if (harnessBeforeViewing === null) {
        harnessBeforeViewing = threadsStore.get().composerHarness
      }
      threadsStore.set({
        viewing: thread,
        opening: null,
        viewingBusy: false,
        run,
        composerHarness: thread.ref.harness,
      })
      // Live from here: the agent writing this session — in whatever app —
      // keeps appending, and those entries belong on screen.
      void getMako().followThread(ref.path, thread.ref.bytes ?? 0)
    } catch (error) {
      if (generation !== viewingGeneration) return
      threadsStore.set({ opening: null, viewingBusy: false })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async loadEarlier() {
    const viewing = threadsStore.get().viewing
    if (!viewing || !viewing.hasEarlier || viewing.loadingEarlier || !hasBridge())
      return
    threadsStore.set({ viewing: { ...viewing, loadingEarlier: true } })
    try {
      const page = await getMako().pageThread(
        viewing.ref.path,
        viewing.pageStart
      )
      const current = threadsStore.get().viewing
      if (!current || current.ref.path !== viewing.ref.path) return
      if (!page) {
        threadsStore.set({ viewing: { ...current, loadingEarlier: false } })
        return
      }
      const next: ViewedThread = {
        ...current,
        ref: page.ref,
        entries: [...page.entries, ...current.entries],
        pageStart: page.start,
        totalEntries: page.total,
        hasEarlier: page.hasEarlier,
        loadingEarlier: false,
        streamRevision: (current.streamRevision ?? 0) + 1,
        streamReplaceFrom: 0,
      }
      threadsStore.set({ viewing: next })
      rememberThread(next)
    } catch (error) {
      const current = threadsStore.get().viewing
      if (current?.ref.path === viewing.ref.path)
        threadsStore.set({ viewing: { ...current, loadingEarlier: false } })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  closeViewer() {
    viewingGeneration += 1
    const restore = harnessBeforeViewing
    harnessBeforeViewing = null
    const patch: Partial<ThreadsState> = {
      viewing: null,
      opening: null,
      viewingBusy: false,
      run: null,
    }
    if (restore !== null) patch.composerHarness = restore
    threadsStore.set(patch)
    if (hasBridge()) void getMako().unfollowThread()
  },
}
