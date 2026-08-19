import { createHook, createStore } from "@/state/store"
import { prefsStore, setPref } from "@/state/prefs"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import type {
  HarnessProfile,
  Thread,
  ThreadEntry,
  ThreadRef,
  ThreadRunState,
} from "@/lib/types"

const HARNESS_NAMES = new Map([
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["devin", "Devin"],
])

function harnessLabelOf(harness: string): string {
  return HARNESS_NAMES.get(harness) ?? harness
}

interface HarnessOptionValues {
  [option: string]: string | boolean
}

interface ComposerTuning {
  model?: string
  effort?: string
  fast?: boolean
  options?: HarnessOptionValues
}

interface ComposerTuningByHarness {
  [harness: string]: ComposerTuning
}

interface RunningThreadsByPath {
  [path: string]: boolean
}

interface QueuedReply {
  ref: ThreadRef
  prompts: string[]
}

interface QueuedRepliesByPath {
  [path: string]: QueuedReply
}

type ViewedUserEntry = Extract<ThreadEntry, { kind: "user" }> & {
  echo?: boolean
}
type ViewedThreadEntry =
  ViewedUserEntry | Exclude<ThreadEntry, { kind: "user" }>

interface ViewedThread extends Omit<Thread, "entries"> {
  entries: ViewedThreadEntry[]
  streamRevision?: number
  streamReplaceFrom?: number
}

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

function isOptimisticEcho(entry: ViewedThreadEntry): boolean {
  return entry.kind === "user" && entry.echo === true
}

/**
 * Every coding agent's sessions on this machine — not just this app's.
 *
 * The host watches every configured provider's native store and pushes the
 * merged catalog here. Nothing in this store polls: a session grown by a
 * terminal on the other monitor
 * arrives as an event, the same way a streaming token does.
 */

interface ThreadsState {
  threads: ThreadRef[]
  loaded: boolean
  /** The foreign thread open in the viewer overlay, if any. */
  viewing: ViewedThread | null
  viewingBusy: boolean
  /** Harnesses whose CLI can be driven headlessly from here. */
  resumable: string[]
  /** Harnesses a conversation can be continued on. */
  targets: string[]
  /** Harnesses that can be driven interactively (ACP). */
  acpable: string[]
  /** The native run for the viewed thread, if one was started. */
  run: ThreadRunState | null
  /** Every live native run, by thread path — the rail's working dots. */
  running: RunningThreadsByPath
  /** A translation in flight: one conversation becoming another harness's. */
  converting: { from: string; to: string; title?: string; done: boolean } | null
  /** The composer's chosen harness for new conversations. */
  composerHarness: string
  /** Per-harness tuning chosen in the composer. */
  composerTuning: ComposerTuningByHarness
  /** Prompts waiting for a thread's current run to end, per path. */
  queuedReplies: QueuedRepliesByPath
}

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  viewingBusy: false,
  resumable: [],
  targets: [],
  acpable: [],
  run: null,
  running: {},
  converting: null,
  composerHarness: prefsStore.get().composerHarness ?? "claude",
  composerTuning: prefsStore.get().composerTuning,
  queuedReplies: {},
})
export const useThreads = createHook(threadsStore)

/** The composer's agent, remembered across launches. */
export function setComposerHarness(harness: string) {
  threadsStore.set({ composerHarness: harness })
  setPref("composerHarness", harness)
}

/**
 * A harness's model/effort/fast choice — kept in Mako's own state, so what
 * the user picked for Codex is still picked tomorrow, whatever any CLI
 * thinks its default is.
 */
export function setComposerTuning(
  harness: string,
  patch: Partial<ComposerTuning>
) {
  const all = threadsStore.get().composerTuning
  const next = { ...all, [harness]: { ...all[harness], ...patch } }
  threadsStore.set({ composerTuning: next })
  setPref("composerTuning", next)
}

/**
 * Copy a provider's starting selection into Mako once. After this boundary,
 * provider config is discovery metadata only: Mako owns the model and option
 * values and never follows later external changes.
 */
export function initializeComposerTuning(profile: HarnessProfile): void {
  if (!profile.available) return
  const prefs = prefsStore.get()
  if (prefs.providerTuningImported.includes(profile.id)) return

  const current = threadsStore.get().composerTuning[profile.id]
  if (!hasExplicitTuning(current)) {
    const imported = tuningFromProfile(profile)
    if (!imported) return
    const next = {
      ...threadsStore.get().composerTuning,
      [profile.id]: imported,
    }
    threadsStore.set({ composerTuning: next })
    setPref("composerTuning", next)
  }
  setPref("providerTuningImported", [
    ...prefs.providerTuningImported,
    profile.id,
  ])
}

function hasExplicitTuning(tuning: ComposerTuning | undefined): boolean {
  return Boolean(
    tuning?.model ||
      tuning?.effort !== undefined ||
      tuning?.fast !== undefined ||
      (tuning?.options && Object.keys(tuning.options).length > 0)
  )
}

function tuningFromProfile(profile: HarnessProfile): ComposerTuning | null {
  const identity = profile.configuredModel ?? profile.defaultModel
  const model = profile.models.find(
    (entry) =>
      entry.id === identity ||
      entry.launchId === identity ||
      entry.aliases?.includes(identity ?? "")
  )
  if (!model) return null

  const options: HarnessOptionValues = {}
  for (const option of model.options) {
    if (option.kind === "boolean") {
      options[option.id] = option.current
      continue
    }
    const value =
      option.current ?? option.values.find((entry) => entry.default)?.value
    if (value !== undefined) options[option.id] = value
  }
  const effortOption = model.options.find(
    (option) =>
      option.kind === "select" &&
      /effort|reason/i.test(`${option.id} ${option.label}`)
  )
  const fastOption = model.options.find(
    (option) => /fast|speed/i.test(`${option.id} ${option.label}`)
  )
  const effort =
    effortOption?.kind === "select"
      ? options[effortOption.id]
      : undefined
  const fast = fastOption ? options[fastOption.id] : undefined
  const imported: ComposerTuning = { model: model.id }
  if (effort !== undefined && effort !== true && effort !== false) {
    imported.effort = effort
  }
  if (fast !== undefined) imported.fast = fast === true || fast === "true"
  if (Object.keys(options).length > 0) imported.options = options
  return imported
}

/** A just-started conversation waiting for its session file to appear. */
let pendingOpen: { harness: string; cwd: string; since: number } | null = null
/** The composer harness to give back when the viewer closes. */
let harnessBeforeViewing: string | null = null

/**
 * Threads already read this run, so switching back is a paint, not a fetch.
 * Stale-while-revalidate: the cached conversation shows instantly and the
 * fresh read replaces it the moment it lands. Bounded; oldest falls out.
 */
const threadCache = new Map<string, ViewedThread>()
const THREAD_CACHE_MAX = 4
const THREAD_CACHE_BYTES = 24 * 1024 * 1024
function estimatedThreadBytes(thread: ViewedThread): number {
  return Math.max(thread.ref.bytes ?? 0, thread.entries.length * 4096)
}

function rememberThread(thread: ViewedThread) {
  threadCache.delete(thread.ref.path)
  threadCache.set(thread.ref.path, thread)
  let bytes = 0
  for (const cached of threadCache.values()) {
    bytes += estimatedThreadBytes(cached)
  }
  while (threadCache.size > 1 && (threadCache.size > THREAD_CACHE_MAX || bytes > THREAD_CACHE_BYTES)) {
    const oldest = threadCache.keys().next().value
    if (!oldest) break
    const removed = threadCache.get(oldest)
    threadCache.delete(oldest)
    if (removed) bytes -= estimatedThreadBytes(removed)
  }
}
let knownPaths = new Set<string>()

export function applyThreadRef(ref: ThreadRef) {
  const current = threadsStore.get().threads
  const at = current.findIndex((entry) => entry.path === ref.path)
  const next = at === -1 ? [...current, ref] : current.map((entry, index) => (index === at ? ref : entry))
  next.sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  )
  applyThreads(next)
}

export function applyThreadRemoved(path: string) {
  applyThreads(threadsStore.get().threads.filter((entry) => entry.path !== path))
}

export function applyThreads(list: ThreadRef[]) {
  threadsStore.set({ threads: list, loaded: true })
  // A conversation started from the composer opens itself the moment the
  // harness writes its session file — the watcher sees it, the list updates,
  // and this picks it out by harness, folder, and birth time.
  if (pendingOpen) {
    const target = pendingOpen
    const candidate = list.find(
      (ref) =>
        !knownPaths.has(ref.path) &&
        ref.harness === target.harness &&
        ref.cwd === target.cwd &&
        (!ref.startedAt || Date.parse(ref.startedAt) >= target.since - 60_000)
    )
    if (candidate) {
      pendingOpen = null
      void threads.view(candidate)
    } else if (Date.now() - target.since > 5 * 60_000) {
      pendingOpen = null
    }
  }
  knownPaths = new Set(list.map((ref) => ref.path))
}

/** A native run started, finished, or failed, on any thread. */
export function applyThreadRun(run: ThreadRunState) {
  const { viewing, running } = threadsStore.get()
  const next = { ...running }
  if (run.status === "running") next[run.path] = true
  else delete next[run.path]
  threadsStore.set({ running: next })
  if (viewing && viewing.ref.path === run.path) threadsStore.set({ run })
  if (run.status === "failed" && run.error) toast.error(run.error)
  // A finished run releases its queue: the next waiting prompt goes out
  // through the same reply path, one at a time, in the order they were
  // typed. Interrupt works the same way — abort stops the run, and the
  // queued message rides the release.
  if (run.status !== "running") {
    const queue = threadsStore.get().queuedReplies[run.path]
    const prompt = queue?.prompts[0]
    if (queue && prompt !== undefined) {
      const rest = queue.prompts.slice(1)
      const all = { ...threadsStore.get().queuedReplies }
      if (rest.length > 0) all[run.path] = { ...queue, prompts: rest }
      else delete all[run.path]
      threadsStore.set({ queuedReplies: all })
      setTimeout(() => void threads.reply(queue.ref, prompt), 50)
    }
  }
}

/** Entries appended — by whatever app is writing — to the viewed thread. */
export function applyThreadEntries(
  path: string,
  entries: ThreadEntry[],
  replace?: boolean,
  replaceFrom?: number
) {
  const { viewing } = threadsStore.get()
  if (!viewing || viewing.ref.path !== path) return
  // The real turn arriving retires its optimistic echo: the reply was
  // painted the instant it was sent, and the file tail is the truth that
  // replaces it rather than doubling it.
  const arrivedUserTexts = new Set(
    entries.filter((entry) => entry.kind === "user").map((entry) => entry.text)
  )
  const base = replace
    ? viewing.entries.slice(0, replaceFrom ?? 0)
    : viewing.entries.filter(
        (entry) =>
          !isOptimisticEcho(entry) ||
          !(entry.kind === "user" && arrivedUserTexts.has(entry.text))
      )
  const next: ViewedThread = {
    ...viewing,
    entries: [...base, ...entries],
  }
  if (replace) {
    next.streamRevision = (viewing.streamRevision ?? 0) + 1
    next.streamReplaceFrom = replaceFrom ?? 0
  }
  threadsStore.set({ viewing: next })
  rememberThread(next)
}

/**
 * Show the translation while it happens, and for long enough to be seen.
 *
 * The emitters are fast — usually under a second — which is exactly why the
 * moment needs a floor: a conversation changing harnesses is the headline
 * act of this app, and a flicker would read as nothing having happened.
 */
export async function withConversion<T>(
  from: string,
  to: string,
  title: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  threadsStore.set({ converting: { from, to, title, done: false } })
  try {
    const result = await work()
    threadsStore.set({ converting: { from, to, title, done: true } })
    setTimeout(() => {
      if (threadsStore.get().converting?.done)
        threadsStore.set({ converting: null })
    }, 300)
    return result
  } catch (error) {
    threadsStore.set({ converting: null })
    throw error
  }
}

let focusRefetch = false

export const threads = {
  /** Re-ask on window focus: cheap, and heals any missed push for good. */
  watchFocus() {
    if (focusRefetch || globalThis.window === undefined) return
    focusRefetch = true
    window.addEventListener("focus", () => void this.load())
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
    threadsStore.set({
      threads: result.threads,
      loaded: result.ready,
      resumable,
      targets,
      acpable,
    })
    // The catalog scans for a moment at boot, and its "here is the list"
    // push can fire while the window is still loading — a lossy first
    // handshake. Retrying until the host says ready is what makes the rail
    // reliable rather than usually-fine.
    if (!result.ready) {
      setTimeout(() => void this.load(), 1500)
    }
  },

  /** Open a foreign session read-only, translated to the canonical shape. */
  async view(ref: ThreadRef) {
    if (!hasBridge()) return
    const cached = threadCache.get(ref.path)
    if (cached) {
      // Instant: the last read paints now, the fresh one lands underneath.
      if (harnessBeforeViewing === null) {
        harnessBeforeViewing = threadsStore.get().composerHarness
      }
      threadsStore.set({
        viewing: cached,
        viewingBusy: false,
        run: null,
        composerHarness: cached.ref.harness,
      })
      void getMako()
        .threadRun(ref.path)
        .then((run) => {
          if (threadsStore.get().viewing?.ref.path === ref.path)
            threadsStore.set({ run })
        })
        .catch(() => {})
      // One follow, registered only after the fresh read, from the fresh
      // byte offset. Following from the cached (stale) offset once replayed
      // the overlap into the viewer as duplicates.
      void getMako()
        .openThread(ref.path)
        .then((fresh) => {
          if (!fresh) return
          const replaced: ViewedThread = {
            ...fresh,
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
    threadsStore.set({ viewingBusy: true })
    try {
      const thread = await getMako().openThread(ref.path)
      if (!thread) throw new Error("This session could not be read")
      rememberThread(thread)
      const run = await getMako()
        .threadRun(ref.path)
        .catch(() => null)
      // The composer adopts this conversation: its agent picker shows the
      // harness that owns the session, and switching it moves the
      // conversation on the next send. No separate "move" ceremony.
      if (harnessBeforeViewing === null) {
        harnessBeforeViewing = threadsStore.get().composerHarness
      }
      threadsStore.set({
        viewing: thread,
        viewingBusy: false,
        run,
        composerHarness: thread.ref.harness,
      })
      // Live from here: the agent writing this session — in whatever app —
      // keeps appending, and those entries belong on screen.
      void getMako().followThread(ref.path, thread.ref.bytes ?? 0)
    } catch (error) {
      threadsStore.set({ viewingBusy: false })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  closeViewer() {
    const restore = harnessBeforeViewing
    harnessBeforeViewing = null
    const patch: Partial<ThreadsState> = {
      viewing: null,
      run: null,
    }
    if (restore !== null) patch.composerHarness = restore
    threadsStore.set(patch)
    if (hasBridge()) void getMako().unfollowThread()
  },

  /**
   * Send the next message through the harness that owns this session. The
   * reply streams back through the file tail — the same path a terminal run
   * takes — so nothing here waits on the process.
   */
  async reply(ref: ThreadRef, prompt: string): Promise<boolean> {
    if (!hasBridge()) return false
    // A busy thread queues instead of dropping: the message paints now (the
    // echo below) and goes out the moment the current run ends.
    if (threadsStore.get().running[ref.path]) {
      const all = { ...threadsStore.get().queuedReplies }
      const queue = all[ref.path] ?? { ref, prompts: [] }
      all[ref.path] = { ref, prompts: [...queue.prompts, prompt] }
      threadsStore.set({ queuedReplies: all })
      const { viewing } = threadsStore.get()
      if (viewing && viewing.ref.path === ref.path) {
        const echo: ViewedUserEntry = {
          kind: "user",
          at: new Date().toISOString(),
          text: prompt,
          echo: true,
        }
        threadsStore.set({
          viewing: { ...viewing, entries: [...viewing.entries, echo] },
        })
      }
      return true
    }
    // Paint the message NOW. The CLI takes a second to launch and the tail
    // another moment to land; a reply that vanishes into that gap reads as
    // a send that failed. The echo carries a flag so the real turn from the
    // file replaces it instead of doubling it.
    const { viewing } = threadsStore.get()
    let echoed = false
    if (viewing && viewing.ref.path === ref.path) {
      const echo: ViewedUserEntry = {
        kind: "user",
        at: new Date().toISOString(),
        text: prompt,
        echo: true,
      }
      threadsStore.set({
        viewing: { ...viewing, entries: [...viewing.entries, echo] },
      })
      echoed = true
    }
    try {
      // The composer's tuning rides on the reply: pick a different model or
      // effort while a conversation is open and the next turn uses it.
      const tuning = threadsStore.get().composerTuning[ref.harness]
      const run = await getMako().resumeThread(ref.path, prompt, tuning)
      // Through the same reducer the host's events use, so the rail's
      // working dot lights immediately rather than on the first event.
      applyThreadRun(run)
      threadsStore.set({ run })
      return true
    } catch (error) {
      // The send failed: take the echo back out so the transcript stays true.
      if (echoed) {
        const current = threadsStore.get().viewing
        if (current && current.ref.path === ref.path) {
          threadsStore.set({
            viewing: {
              ...current,
              entries: current.entries.filter(
                (entry) =>
                  !isOptimisticEcho(entry) ||
                  entry.kind !== "user" ||
                  entry.text !== prompt
              ),
            },
          })
        }
      }
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /** Move and send through the selected provider, using transcript replay by default. */
  async moveAndSend(
    ref: ThreadRef,
    harness: string,
    prompt: string
  ): Promise<boolean> {
    if (!hasBridge()) return false
    try {
      const mode = prefsStore.get().conversionMode
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getMako().continueThreadWith(ref.path, harness, prompt, mode)
      )
      if (result.kind === "emitted") {
        const thread = await getMako().openThread(result.path)
        if (thread) {
          threadsStore.set({ viewing: thread, run: null })
          void getMako().followThread(result.path, thread.ref.bytes ?? 0)
          return this.reply(thread.ref, prompt)
        }
      } else if (result.kind === "prepared") {
        threadsStore.set({ composerHarness: harness })
        const supportsLive = threadsStore.get().acpable.includes(harness)
        return supportsLive
          ? (await import("@/state/acp")).acp.startFresh(
              harness,
              result.cwd,
              result.prompt
            )
          : this.startNew(harness, result.prompt)
      }
      return false
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /** Fork after one completed answer, using the transcript bundle as context. */
  async forkAt(
    ref: ThreadRef,
    upto: number,
    harness: string
  ): Promise<boolean> {
    if (!hasBridge()) return false
    try {
      const prepared = await withConversion(
        ref.harness,
        harness,
        ref.title,
        () => getMako().forkThread(ref.path, upto, harness)
      )
      threadsStore.set({ composerHarness: harness })
      const supportsLive = threadsStore.get().acpable.includes(harness)
      const ok = supportsLive
        ? await (
            await import("@/state/acp")
          ).acp.startFresh(harness, prepared.cwd, prepared.prompt)
        : await this.startNew(harness, prepared.prompt)
      if (ok) {
        toast("Forked", {
          description: `A new ${harnessLabelOf(harness)} conversation starts after that answer.`,
        })
      }
      return ok
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async abortReply(ref: ThreadRef) {
    if (!hasBridge()) return
    await getMako()
      .abortThreadRun(ref.path)
      .catch(() => {})
  },

  /**
   * Interrupt and send: stop the current turn, and the message goes out on
   * the release. One gesture — the queue machinery does the sequencing.
   */
  async interruptAndSend(ref: ThreadRef, prompt: string): Promise<boolean> {
    if (!hasBridge()) return false
    const ok = await this.reply(ref, prompt)
    if (ok && threadsStore.get().running[ref.path]) {
      await getMako()
        .abortThreadRun(ref.path)
        .catch(() => {})
    }
    return ok
  },

  /**
   * A new conversation on another harness, straight from the composer. The
   * CLI runs headlessly in the active workspace; when its session file
   * appears, the conversation opens here and the reply bar carries the next
   * turn. Same chat column, different agent — which is the whole idea.
   */
  async startNew(harness: string, prompt: string) {
    if (!hasBridge()) return false
    try {
      const options = threadsStore.get().composerTuning[harness] ?? {}
      const { cwd } = await getMako().startHarness(harness, prompt, options)
      pendingOpen = { harness, cwd, since: Date.now() }
      toast(`${harnessLabelOf(harness)} is on it`, {
        description:
          "The conversation opens here as soon as its first write lands.",
      })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async continueWith(ref: ThreadRef, harness: string, label: string) {
    if (!hasBridge()) return false
    try {
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getMako().continueThreadWith(
          ref.path,
          harness,
          undefined,
          prefsStore.get().conversionMode
        )
      )
      if (result.kind === "emitted") {
        const thread = await getMako().openThread(result.path)
        if (!thread) return false
        threadsStore.set({ viewing: thread, run: null })
        void getMako().followThread(result.path, thread.ref.bytes ?? 0)
        toast(`${label} session imported`, {
          description: "Reply below when you are ready to continue.",
        })
        return true
      }
      threadsStore.set({ composerHarness: harness })
      const supportsLive = threadsStore.get().acpable.includes(harness)
      const ok = supportsLive
        ? await (
            await import("@/state/acp")
          ).acp.startFresh(harness, result.cwd, result.prompt)
        : await this.startNew(harness, result.prompt)
      if (ok) toast(`${label} picked up the conversation`)
      return ok
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },
}
