import { createHook, createStore } from "@/state/store"
import { prefsStore, setPref } from "@/state/prefs"
import { getPi, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"

const HARNESS_NAMES: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  devin: "Devin",
}
function harnessLabelOf(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness
}
import type { Thread, ThreadEntry, ThreadRef, ThreadRunState } from "@/lib/types"

/**
 * Every coding agent's sessions on this machine — not just this app's.
 *
 * The host watches the native stores of every harness it knows (Pi, Codex,
 * Claude Code, Cursor, Grok) and pushes the merged catalog here. Nothing in
 * this store polls: a session grown by a terminal on the other monitor
 * arrives as an event, the same way a streaming token does.
 */

interface ThreadsState {
  threads: ThreadRef[]
  loaded: boolean
  /** The foreign thread open in the viewer overlay, if any. */
  viewing: Thread | null
  viewingBusy: boolean
  continuing: string | null
  /** Harnesses whose CLI can be driven headlessly from here. */
  resumable: string[]
  /** Harnesses a conversation can be continued on, "pi" first. */
  targets: string[]
  /** Harnesses that can be driven interactively (ACP). */
  acpable: string[]
  /** The native run for the viewed thread, if one was started. */
  run: ThreadRunState | null
  /** Every live native run, by thread path — the rail's working dots. */
  running: Record<string, boolean>
  /** A translation in flight: one conversation becoming another harness's. */
  converting: { from: string; to: string; title?: string; done: boolean } | null
  /** The composer's chosen harness for new conversations. */
  composerHarness: string
  /** Per-harness tuning chosen in the composer. */
  composerTuning: Record<string, { model?: string; effort?: string; fast?: boolean }>
  /** Prompts waiting for a thread's current run to end, per path. */
  queuedReplies: Record<string, { ref: ThreadRef; prompts: string[] }>
}

export const threadsStore = createStore<ThreadsState>({
  threads: [],
  loaded: false,
  viewing: null,
  viewingBusy: false,
  continuing: null,
  resumable: [],
  targets: [],
  acpable: [],
  run: null,
  running: {},
  converting: null,
  // Mako fronts the harnesses; Pi is the engine room, not a choice on the
  // menu. The last-used agent comes back across launches.
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
  patch: Partial<{ model?: string; effort?: string; fast?: boolean }>
) {
  const all = threadsStore.get().composerTuning
  const next = { ...all, [harness]: { ...all[harness], ...patch } }
  threadsStore.set({ composerTuning: next })
  setPref("composerTuning", next)
}

/**
 * Each harness's own defaults, as last read from its config files by the
 * engine and remembered here — never invented. Until the first read lands
 * there is simply no name to show, and honesty beats a wrong model id.
 */
export function harnessDefault(harness: string): { model?: string; effort?: string } {
  return prefsStore.get().harnessDefaults[harness] ?? {}
}

export function rememberHarnessDefault(
  harness: string,
  next: { model?: string; effort?: string }
) {
  if (!next.model && !next.effort) return
  const all = prefsStore.get().harnessDefaults
  const current = all[harness]
  if (current?.model === next.model && current?.effort === next.effort) return
  setPref("harnessDefaults", { ...all, [harness]: next })
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
const threadCache = new Map<string, Thread>()
const THREAD_CACHE_MAX = 12
function rememberThread(thread: Thread) {
  threadCache.delete(thread.ref.path)
  threadCache.set(thread.ref.path, thread)
  if (threadCache.size > THREAD_CACHE_MAX) {
    const oldest = threadCache.keys().next().value
    if (oldest) threadCache.delete(oldest)
  }
}
let knownPaths = new Set<string>()

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
export function applyThreadEntries(path: string, entries: ThreadEntry[], replace?: boolean) {
  const { viewing } = threadsStore.get()
  if (!viewing || viewing.ref.path !== path) return
  // The real turn arriving retires its optimistic echo: the reply was
  // painted the instant it was sent, and the file tail is the truth that
  // replaces it rather than doubling it.
  const arrivedUserTexts = new Set(
    entries.filter((entry) => entry.kind === "user").map((entry) => entry.text)
  )
  const base = replace
    ? []
    : viewing.entries.filter(
        (entry) =>
          !(entry as { echo?: boolean }).echo ||
          !(entry.kind === "user" && arrivedUserTexts.has(entry.text))
      )
  const next = { ...viewing, entries: [...base, ...entries] }
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
  const started = Date.now()
  threadsStore.set({ converting: { from, to, title, done: false } })
  try {
    const result = await work()
    const remaining = Math.max(0, 900 - (Date.now() - started))
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
    threadsStore.set({ converting: { from, to, title, done: true } })
    await new Promise((resolve) => setTimeout(resolve, 700))
    return result
  } finally {
    threadsStore.set({ converting: null })
  }
}

let focusRefetch = false

export const threads = {
  /** Re-ask on window focus: cheap, and heals any missed push for good. */
  watchFocus() {
    if (focusRefetch || typeof window === "undefined") return
    focusRefetch = true
    window.addEventListener("focus", () => void this.load())
  },

  async load() {
    if (!hasBridge()) return
    const [raw, resumable, targets, acpable] = await Promise.all([
      getPi()
        .threads()
        .catch(() => ({ ready: false, threads: [] as ThreadRef[] })),
      getPi().resumableHarnesses().catch((): string[] => []),
      getPi().continueTargets().catch((): string[] => []),
      getPi().acpHarnesses().catch((): string[] => []),
    ])
    // An engine one vintage older answers with a bare array; treat it as
    // ready rather than spinning forever against the shape difference.
    const result = Array.isArray(raw) ? { ready: true, threads: raw as ThreadRef[] } : raw
    threadsStore.set({ threads: result.threads, loaded: result.ready, resumable, targets, acpable })
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
        composerHarness: cached.ref.harness === "pi" ? "devin" : cached.ref.harness,
      })
      void getPi().followThread(ref.path, cached.ref.bytes ?? 0)
      void getPi()
        .threadRun(ref.path)
        .then((run) => {
          if (threadsStore.get().viewing?.ref.path === ref.path) threadsStore.set({ run })
        })
        .catch(() => {})
      void getPi()
        .openThread(ref.path)
        .then((fresh) => {
          if (!fresh) return
          rememberThread(fresh)
          if (threadsStore.get().viewing?.ref.path === ref.path) {
            threadsStore.set({ viewing: fresh })
          }
        })
        .catch(() => {})
      return
    }
    threadsStore.set({ viewingBusy: true })
    try {
      const thread = await getPi().openThread(ref.path)
      if (!thread) throw new Error("This session could not be read")
      rememberThread(thread)
      const run = await getPi().threadRun(ref.path).catch(() => null)
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
        composerHarness: thread.ref.harness === "pi" ? "devin" : thread.ref.harness,
      })
      // Live from here: the agent writing this session — in whatever app —
      // keeps appending, and those entries belong on screen.
      void getPi().followThread(ref.path, thread.ref.bytes ?? 0)
    } catch (error) {
      threadsStore.set({ viewingBusy: false })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  closeViewer() {
    const restore = harnessBeforeViewing
    harnessBeforeViewing = null
    threadsStore.set({
      viewing: null,
      run: null,
      ...(restore !== null ? { composerHarness: restore } : {}),
    })
    if (hasBridge()) void getPi().unfollowThread()
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
        const echo = { kind: "user", at: new Date().toISOString(), text: prompt } as ThreadEntry & {
          echo: boolean
        }
        echo.echo = true
        threadsStore.set({ viewing: { ...viewing, entries: [...viewing.entries, echo] } })
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
      const echo = {
        kind: "user",
        at: new Date().toISOString(),
        text: prompt,
      } as ThreadEntry & { echo: boolean }
      echo.echo = true
      threadsStore.set({ viewing: { ...viewing, entries: [...viewing.entries, echo] } })
      echoed = true
    }
    try {
      // The composer's tuning rides on the reply: pick a different model or
      // effort while a conversation is open and the next turn uses it.
      const tuning = threadsStore.get().composerTuning[ref.harness]
      const run = await getPi().resumeThread(ref.path, prompt, tuning)
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
                  !(entry as { echo?: boolean }).echo ||
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

  /**
   * Reply through a *different* harness: the move IS the reply. The
   * conversation becomes a native session at the destination — emitted
   * into its store when we can write it, spawned from the transcript when
   * we cannot — and the message goes out as its first turn there.
   */
  async moveAndSend(ref: ThreadRef, harness: string, prompt: string): Promise<boolean> {
    if (!hasBridge()) return false
    if (harness === "pi" || harness === "devin") {
      const moved = await this.continueHere(ref)
      if (!moved) return false
      const { actions, store } = await import("@/state/session")
      if (harness === "devin") {
        const devin = store.get().models.find((model) => model.provider === "devin")
        const current = store.get().meta?.model
        if (devin && current?.provider !== "devin") await actions.setModel(devin.provider, devin.id)
      }
      if (prompt.trim()) {
        return Boolean(await actions.send(prompt))
      }
      return true
    }
    try {
      const mode = prefsStore.get().conversionMode
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getPi().continueThreadWith(ref.path, harness, prompt, mode)
      )
      if (result.kind === "emitted") {
        const thread = await getPi().openThread(result.path)
        if (thread) {
          threadsStore.set({ viewing: thread, run: null })
          void getPi().followThread(result.path, thread.ref.bytes ?? 0)
          return this.reply(thread.ref, prompt)
        }
      } else if (result.kind === "spawned") {
        // The prompt rode along as part of the handoff; the new session
        // opens itself when the watcher sees its first write.
        pendingOpen = { harness, cwd: ref.cwd ?? "", since: Date.now() }
        threadsStore.set({ viewing: null, run: null })
        return true
      }
      return false
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async abortReply(ref: ThreadRef) {
    if (!hasBridge()) return
    await getPi().abortThreadRun(ref.path).catch(() => {})
  },

  /**
   * Interrupt and send: stop the current turn, and the message goes out on
   * the release. One gesture — the queue machinery does the sequencing.
   */
  async interruptAndSend(ref: ThreadRef, prompt: string): Promise<boolean> {
    if (!hasBridge()) return false
    const ok = await this.reply(ref, prompt)
    if (ok && threadsStore.get().running[ref.path]) {
      await getPi().abortThreadRun(ref.path).catch(() => {})
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
      const { cwd } = await getPi().startHarness(harness, prompt, options)
      pendingOpen = { harness, cwd, since: Date.now() }
      toast(`${harnessLabelOf(harness)} is on it`, {
        description: "The conversation opens here as soon as its first write lands.",
      })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /**
   * Continue this conversation on a different harness: the transcript
   * becomes the first prompt of a fresh session there. "pi" opens a tab in
   * this app; anything else runs headlessly and surfaces in the rail when
   * its session store appears — which the watcher notices, not this code.
   */
  async continueWith(ref: ThreadRef, harness: string, label: string) {
    if (harness === "pi") return this.continueHere(ref)
    if (!hasBridge()) return false
    try {
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getPi().continueThreadWith(ref.path, harness, undefined, prefsStore.get().conversionMode)
      )
      if (result.kind === "emitted") {
        // The conversation now exists natively in the target's store. Open
        // it in the viewer — instantly replyable, nothing spent yet.
        const thread = await getPi().openThread(result.path)
        if (thread) {
          threadsStore.set({ viewing: thread, run: null })
          void getPi().followThread(result.path, thread.ref.bytes ?? 0)
          toast(`Now a native ${label} session`, {
            description: "Same conversation, new harness. Reply below to set it working.",
          })
          return true
        }
      }
      threadsStore.set({ viewing: null, run: null })
      toast(`${label} picked up the conversation`, {
        description: `Working in ${ref.cwd ?? "its workspace"} — it will appear under Agents.`,
      })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /**
   * Continue a foreign conversation here: a new tab in its working
   * directory, seeded with the transcript. The tab opens on success; the
   * session store's tab machinery takes it from there.
   */
  async continueHere(ref: ThreadRef, instruction?: string) {
    if (!hasBridge()) return false
    threadsStore.set({ continuing: ref.path })
    try {
      void instruction
      await withConversion(ref.harness, "pi", ref.title, () => getPi().continueThread(ref.path))
      threadsStore.set({ continuing: null, viewing: null })
      return true
    } catch (error) {
      threadsStore.set({ continuing: null })
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },
}
