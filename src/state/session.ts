import { createHook, createStore, shallowEqual } from "@/state/store"
import type {
  Capabilities,
  GitStatus,
  HostEvent,
  ModelInfo,
  ChatMessage,
  SessionMeta,
  SessionState,
  SessionSummary,
  TabSnapshot,
  ThinkingLevel,
  TreeNode,
} from "@/lib/types"
import { getMako, hasBridge } from "@/lib/bridge"
import { reconcileMessages } from "@/lib/reconcile"
import { composerTurnRunning } from "@/lib/composer-action"
import { prefsStore } from "@/state/prefs"
import {
  addTab,
  cacheOf,
  dropCache,
  hydrate,
  patchTab,
  refresh,
  removeTab,
  tabsStore,
  writeCache,
} from "@/state/tabs"
import { viewer, viewerStore } from "@/state/viewer"
import { stage } from "@/state/stage"
import { applyUpdate, updates } from "@/state/updates"
import {
  applyAutomations,
  automations,
  noteAutomationRun,
} from "@/state/automations"
import {
  applyThreadEntries,
  applyThreadRef,
  applyThreadRemoved,
  applyThreadRun,
  applyThreads,
  threads,
  threadsStore,
} from "@/state/threads"
import {
  acp,
  acpStore,
  applyAcpPermission,
  applyAcpSession,
  applyAcpUpdate,
  applyAcpUpdates,
} from "@/state/acp"
import { watchOnboarding } from "@/state/onboarding"
import { toast } from "sonner"

export type Phase = "booting" | "ready" | "detached"

export interface SessionStore {
  phase: Phase
  fault?: string
  meta?: SessionMeta
  messages: ChatMessage[]
  /** The in-flight assistant message. Isolated so tokens touch one subtree. */
  stream: ChatMessage | null
  tree: TreeNode[]
  git?: GitStatus
  models: ModelInfo[]
  capabilities: Capabilities
  sessions: SessionSummary[]
  sessionsLoading: boolean
  platform: NodeJS.Platform | "unknown"
  /** Mako's own source tree, when it is editable — development only. */
  sourceRoot?: string
}

const empty: Capabilities = { tools: [], commands: [], skills: [] }
let workspaceGeneration = 0

export const store = createStore<SessionStore>({
  phase: "booting",
  messages: [],
  stream: null,
  tree: [],
  models: [],
  capabilities: empty,
  sessions: [],
  sessionsLoading: true,
  platform: "unknown",
})

export const useSession = createHook(store)
export { shallowEqual }

export function currentTurnRunning(): boolean {
  const acpState = acpStore.get()
  return composerTurnRunning({
    builtinRunning: store.get().meta?.isStreaming ?? false,
    livePresent: Boolean(acpState.session),
    liveRunning: acpState.session?.status === "running",
    liveThreadPath: acpState.threadPath,
    viewingPath: threadsStore.get().viewing?.ref.path,
    viewingRunning: threadsStore.get().run?.status === "running",
  })
}

/* ------------------------------------------------------------------ */
/* event application                                                   */
/* ------------------------------------------------------------------ */

/**
 * Route one host event.
 *
 * Several agents are running, so the first question is always "whose is this?".
 * Events for the tab on screen land in the store and repaint. Events for a
 * background tab go into its cache and touch nothing but its entry in the tab
 * strip — a conversation you are not looking at costs one small object write,
 * not a render.
 */
function apply(event: HostEvent) {
  const active = tabsStore.get().activeId
  if (event.tabId && event.tabId !== active) {
    absorb(event.tabId, event)
    return
  }
  applyToActive(event)
  if (
    event.tabId &&
    (event.type === "meta" ||
      event.type === "session" ||
      event.type === "messages")
  ) {
    const state = store.get()
    writeCache(event.tabId, { meta: state.meta })
    refresh(event.tabId, { ...cacheOf(event.tabId), messages: state.messages })
  }
}

/** Fold a background tab's event into its cache, and update its strip entry. */
function absorb(id: string, event: HostEvent) {
  const entry = cacheOf(id)
  switch (event.type) {
    case "session":
      writeCache(id, {
        meta: event.session.meta,
        messages: event.session.messages,
        tree: event.session.tree,
        stream: null,
      })
      break
    case "meta":
      writeCache(id, { meta: event.meta })
      break
    case "messages":
      writeCache(id, { messages: event.messages })
      break
    case "tree":
      writeCache(id, { tree: event.tree })
      break
    case "git":
      if (entry.meta?.cwd !== event.git.cwd) return
      writeCache(id, { git: event.git })
      break
    case "capabilities":
      writeCache(id, { capabilities: event.capabilities })
      break
    case "notice":
      // Errors from a hidden tab still surface — a failure you never see is
      // worse than an interruption — but they say which conversation raised it.
      if (event.level === "error") report(event.message)
      return
    default:
      return
  }

  const previous = entry.meta
  const next = cacheOf(id)
  refresh(id, next)
  // Finished while you were elsewhere: that is worth a dot on the tab.
  const wasWorking = Boolean(previous?.isStreaming || previous?.isCompacting)
  const nowWorking = Boolean(next.meta?.isStreaming || next.meta?.isCompacting)
  if (wasWorking && !nowWorking) patchTab(id, { unread: true })
}

/** Re-read the open file when the agent's last turn touched it. */
function followEdits(git: GitStatus) {
  const path = viewerStore.get().path
  if (!path) return
  if (git.files.some((file) => file.path === path)) viewer.refresh()
}

function applyToActive(event: HostEvent) {
  switch (event.type) {
    case "session":
      store.set({
        meta: event.session.meta,
        messages: reconcileMessages(
          store.get().messages,
          event.session.messages
        ),
        tree: event.session.tree,
        stream: null,
      })
      break
    case "meta":
      store.set({ meta: event.meta })
      break
    case "messages":
      // Reuse the objects for turns that did not change, so a tool result
      // re-renders one turn instead of the whole transcript.
      store.set({
        messages: reconcileMessages(store.get().messages, event.messages),
      })
      break
    case "stream":
      store.set({ stream: event.message })
      break
    case "tree":
      store.set({ tree: event.tree })
      break
    case "git":
      if (store.get().meta?.cwd !== event.git.cwd) return
      store.set({ git: event.git })
      // The agent just wrote something. If it wrote the file you happen to be
      // reading, the version on screen is now wrong — and a stale file is
      // worse than no file, because nothing about it looks stale.
      followEdits(event.git)
      break
    case "capabilities":
      store.set({ capabilities: event.capabilities })
      break
    case "update":
      applyUpdate(event.update)
      break
    case "automations":
      applyAutomations(event.automations)
      break
    case "threads":
      applyThreads(event.threads)
      break
    case "thread-ref":
      applyThreadRef(event.ref)
      break
    case "thread-removed":
      applyThreadRemoved(event.path)
      break
    case "thread-entries":
      applyThreadEntries(
        event.path,
        event.entries,
        event.replace,
        event.replaceFrom
      )
      break
    case "thread-run":
      applyThreadRun(event.run)
      break
    case "file-changed":
      void viewer.refresh(event.path)
      break
    case "acp-session":
      applyAcpSession(event.session)
      break
    case "acp-update":
      applyAcpUpdate(event.id, event.update)
      break
    case "acp-updates":
      applyAcpUpdates(event.id, event.updates)
      break
    case "acp-permission":
      applyAcpPermission(event.request)
      break
    case "automation-run":
      noteAutomationRun(event.run)
      if (event.run.status === "started" && event.run.reason === "manual") {
        toast(`${event.run.name} started`, {
          description: "run by hand",
        })
      } else if (event.run.status === "failed") {
        toast.error(`${event.run.name} failed`, {
          description: event.run.error,
          action: {
            label: "Run again",
            onClick: () => automations.run(event.run.id),
          },
        })
      }
      break
    case "notice":
      if (event.level === "error") report(event.message)
      else if (event.level === "success") toast.success(event.message)
      else toast(event.message)
      break
  }
}

/* ------------------------------------------------------------------ */
/* actions — every mutation the UI can perform, in one place           */
/* ------------------------------------------------------------------ */

function report(message: string) {
  toast.error(message, {
    action: {
      label: "Troubleshoot",
      onClick: () =>
        window.dispatchEvent(
          new CustomEvent("mako:settings", { detail: "diagnostics" })
        ),
    },
  })
}

/** Reject after `ms`, so no await can strand the interface in a skeleton. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ])
}

async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    report(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/**
 * Which session file a tab is showing.
 *
 * The active tab's is in the store, not the cache — the cache for the tab you
 * are looking at is only written when you leave it — so both have to be read.
 */
function sessionFileOf(id: string): string | undefined {
  if (id === tabsStore.get().activeId) return store.get().meta?.sessionFile
  return cacheOf(id).meta?.sessionFile
}

/** Put a fresh session state on screen and keep the tab strip in step with it. */
function adoptState(next: SessionState) {
  store.set({
    meta: next.meta,
    messages: reconcileMessages(store.get().messages, next.messages),
    tree: next.tree,
    stream: null,
  })
  const id = tabsStore.get().activeId
  if (id) {
    writeCache(id, { meta: next.meta })
    refresh(
      id,
      { ...cacheOf(id), meta: next.meta, messages: next.messages },
      { unread: false }
    )
  }
}

function adoptSnapshot(next: TabSnapshot) {
  store.set({
    meta: next.session.meta,
    messages: reconcileMessages(store.get().messages, next.session.messages),
    tree: next.session.tree,
    stream: null,
    git: next.git,
    capabilities: next.capabilities,
  })
  writeCache(next.id, {
    meta: next.session.meta,
    messages: next.session.messages,
    tree: next.session.tree,
    git: next.git,
    capabilities: next.capabilities,
  })
  refresh(next.id, cacheOf(next.id), { unread: false })
}

export const actions = {
  async boot() {
    if (!hasBridge()) {
      store.set({
        phase: "detached",
        fault:
          "The agent host is not attached. Launch the desktop app with `npm run desktop`.",
      })
      return () => {}
    }
    const bridge = getMako()
    // The renderer hot-reloads through Vite; the engine does not. When this
    // window is newer than the engine it woke up inside — the bridge missing
    // an API this build requires — nothing works *subtly*, which is the
    // worst way for nothing to work. Refuse loudly, with the fix.
    if (!Object.hasOwn(bridge, "daemonStatus")) {
      store.set({
        phase: "detached",
        fault:
          "This window is newer than the engine it is connected to — the interface hot-reloaded past the running app. Quit the app and run `npm run desktop` again to rebuild and restart the engine.",
      })
      return () => {}
    }
    const unsubscribe = bridge.onEvent(apply)
    try {
      const boot = await withTimeout(
        bridge.boot(),
        45_000,
        "The agent host did not answer within 45 seconds. Check the terminal it was launched from, then restart."
      )
      hydrate(boot.tabs, boot.activeTabId)
      const active =
        boot.tabs.find((tab) => tab.id === boot.activeTabId) ?? boot.tabs[0]
      if (!active) throw new Error("The host started without a conversation")
      store.set({
        phase: "ready",
        meta: active.session.meta,
        messages: active.session.messages,
        tree: active.session.tree,
        git: active.git,
        models: boot.models,
        capabilities: active.capabilities,
        platform: boot.platform,
        sourceRoot: boot.sourceRoot,
      })
      void actions.refreshSessions(active.session.meta.cwd)
      void updates.load()
      void automations.load()
      void threads.load()
      threads.watchFocus()
      watchOnboarding()
    } catch (error) {
      store.set({
        phase: "detached",
        fault: error instanceof Error ? error.message : String(error),
      })
    }
    return unsubscribe
  },

  /* ---------------------------------------------------------------- tabs */

  /**
   * Show a different tab.
   *
   * The conversation you are leaving is written to its cache and the one you
   * are entering is read back from it, so the swap is a single synchronous
   * paint. The host is told afterwards — it will re-push authoritative state,
   * which arrives a frame or two later and reconciles into what is already on
   * screen rather than replacing it.
   */
  async switchTab(id: string) {
    const { activeId } = tabsStore.get()
    if (id === activeId) return
    const current = store.get()
    if (activeId) {
      writeCache(activeId, {
        meta: current.meta,
        messages: current.messages,
        stream: current.stream,
        tree: current.tree,
        git: current.git,
        capabilities: current.capabilities,
      })
    }
    const next = cacheOf(id)
    tabsStore.set({ activeId: id })
    patchTab(id, { unread: false })
    store.set({
      meta: next.meta,
      messages: next.messages,
      stream: next.stream,
      tree: next.tree,
      git: next.git,
      capabilities: next.capabilities ?? empty,
    })
    dropCache(id)
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    await guard(() => getMako().activateTab(id))
    if (next.meta?.cwd) void actions.refreshSessions(next.meta.cwd)
  },

  /** Open another conversation beside this one. */
  async openTab(options: { cwd?: string; sessionPath?: string } = {}) {
    const current = store.get()
    const { activeId } = tabsStore.get()
    if (activeId) {
      writeCache(activeId, {
        meta: current.meta,
        messages: current.messages,
        stream: current.stream,
        tree: current.tree,
        git: current.git,
        capabilities: current.capabilities,
      })
    }
    const tab = await guard(() => getMako().openTab(options))
    if (!tab) return false
    addTab(tab)
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    store.set({
      meta: tab.session.meta,
      messages: tab.session.messages,
      stream: null,
      tree: tab.session.tree,
      git: tab.git,
      capabilities: tab.capabilities,
    })
    void actions.refreshSessions(tab.session.meta.cwd)
    return true
  },

  async closeTab(id: string) {
    const result = await guard(() => getMako().closeTab(id))
    if (!result) return
    const wasActive = tabsStore.get().activeId === id
    removeTab(id, result.activeId)
    stage.drop(id)
    if (result.opened) addTab(result.opened)
    if (!wasActive) return
    const next = cacheOf(result.activeId)
    store.set({
      meta: next.meta,
      messages: next.messages,
      stream: next.stream,
      tree: next.tree,
      git: next.git,
      capabilities: next.capabilities ?? empty,
    })
    dropCache(result.activeId)
    patchTab(result.activeId, { unread: false })
    if (next.meta?.cwd) void actions.refreshSessions(next.meta.cwd)
  },

  async refreshSessions(cwd?: string, scope?: "workspace" | "all") {
    if (!hasBridge()) return
    store.set({ sessionsLoading: true })
    try {
      // A list that never answers must still resolve into something the user
      // can see and retry — an eternal skeleton is the one unacceptable
      // outcome here.
      const next = await withTimeout(
        getMako().listSessions(
          cwd ?? store.get().meta?.cwd,
          scope ?? prefsStore.get().railScope
        ),
        20_000,
        "Listing sessions took too long"
      )
      store.set({ sessions: next })
    } catch (error) {
      report(error instanceof Error ? error.message : String(error))
    } finally {
      store.set({ sessionsLoading: false })
    }
  },

  async refreshModels() {
    const models = await guard(() => getMako().listModels())
    if (models) store.set({ models })
  },

  /**
   * Send a prompt. Resolves `true` only if the host accepted it.
   *
   * The composer clears optimistically so typing feels instant, and it can
   * only put the draft back if it can tell success from failure — which a
   * `void`-returning call cannot. The agent rejects a prompt outright when no
   * model is selected or no key is available, and losing a paragraph to that
   * is not an acceptable way to find out.
   */
  async send(
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ): Promise<boolean> {
    try {
      await getMako().prompt(text, mode, images)
      return true
    } catch (error) {
      report(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  abort() {
    return guard(() => getMako().abort())
  },

  async stopCurrentTurn() {
    const live = acpStore.get().session
    const liveThreadPath = acpStore.get().threadPath
    const viewing = threadsStore.get().viewing?.ref
    const viewingOwnsComposer = Boolean(
      viewing && (!live || viewing.path !== liveThreadPath)
    )
    if (viewingOwnsComposer && viewing)
      return threads.abortReply(viewing)
    if (live?.status === "running") return acp.cancel()
    if (store.get().meta?.isStreaming) {
      await actions.abort()
      return true
    }
    return false
  },

  clearQueue() {
    return guard(() => getMako().clearQueue())
  },

  async newConversationIn(folder = store.get().meta?.cwd) {
    const acpState = acpStore.get()
    const live = acpState.session
    if (acpState.starting) {
      toast.error("Wait for the active conversation to start")
      return false
    }
    if (live?.status === "running") {
      toast.error("Stop the active conversation before starting another", {
        action: { label: "Stop", onClick: () => acp.cancel() },
      })
      return false
    }
    if (live) acp.close()
    threads.closeViewer()
    viewer.close()
    stage.close()
    const opened = await actions.openTab(folder ? { cwd: folder } : {})
    if (!opened) return false
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("mako:focus-composer"))
    )
    return true
  },

  async newSession() {
    return actions.newConversationIn()
  },

  /**
   * Show a thread. `inNewTab` keeps the current one running beside it, which is
   * what a modifier-click means everywhere else.
   */
  async openSession(path: string, { inNewTab = false } = {}) {
    // Already open somewhere? Go there. Two tabs on one session file would be
    // two views of one runtime fighting over it, and the rail giving you a
    // duplicate instead of the thing you can see is the wrong answer anyway.
    const existing = tabsStore
      .get()
      .tabs.find((tab) => sessionFileOf(tab.id) === path)
    if (existing) return actions.switchTab(existing.id)
    if (inNewTab) return actions.openTab({ sessionPath: path })
    // Picking a thread means "show me that thread" — so any full-window view
    // standing in front of the transcript steps aside first.
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    const next = await guard(() => getMako().openSession(path))
    if (!next) return
    adoptState(next)
    void actions.refreshSessions(next.meta.cwd)
  },

  async pickWorkspace() {
    const folder = await guard(() => getMako().pickFolder())
    if (folder) await actions.newConversationIn(folder)
  },

  /** Point the agent at a folder by path, without a dialog. */
  async openWorkspace(folder: string) {
    const mine = ++workspaceGeneration
    const next = await guard(() => getMako().setCwd(folder))
    if (!next || mine !== workspaceGeneration) return
    adoptSnapshot(next)
    viewer.close()
    void actions.refreshSessions(folder)
    void actions.refreshModels()
  },

  /**
   * Branch at a past turn into a new session, in a tab of its own.
   *
   * Both halves matter. The new session means the original is not rewound and
   * abandoned; the new *tab* means both lines of enquiry are on screen at once,
   * which is the only reason to want two of them. The prompt that was forked
   * from comes back so it can go straight into the composer — retyping it is
   * the one thing the feature exists to avoid.
   */
  async fork(entryId: string, position: "before" | "at" = "before") {
    const current = store.get()
    const { activeId } = tabsStore.get()
    if (activeId) {
      writeCache(activeId, {
        meta: current.meta,
        messages: current.messages,
        stream: current.stream,
        tree: current.tree,
        git: current.git,
        capabilities: current.capabilities,
      })
    }
    const result = await guard(() => getMako().fork(entryId, position))
    if (!result || result.cancelled) return
    addTab(result.tab)
    store.set({
      meta: result.tab.session.meta,
      messages: result.tab.session.messages,
      stream: null,
      tree: result.tab.session.tree,
      git: result.tab.git,
      capabilities: result.tab.capabilities,
    })
    void actions.refreshSessions(result.tab.session.meta.cwd)
    if (result.text) {
      window.dispatchEvent(
        new CustomEvent("mako:compose", { detail: result.text })
      )
    }
  },

  async navigate(nodeId: string) {
    const next = await guard(() => getMako().navigateTree(nodeId))
    if (!next) return
    adoptState(next)
  },

  rename(name: string) {
    return guard(() => getMako().setName(name))
  },

  setModel(provider: string, id: string) {
    return guard(() => getMako().setModel(provider, id))
  },

  setThinking(level: ThinkingLevel) {
    return guard(() => getMako().setThinking(level))
  },

  compact(instructions?: string) {
    return guard(() => getMako().compact(instructions))
  },

  setAutoCompaction(enabled: boolean) {
    return guard(() => getMako().setAutoCompaction(enabled))
  },

  setActiveTools(names: string[]) {
    return guard(() => getMako().setActiveTools(names))
  },

  runCommand(name: string, args?: string) {
    return guard(() => getMako().runCommand(name, args))
  },

  async refreshGit() {
    const workspace = store.get().meta?.cwd
    const git = await guard(() => getMako().gitStatus())
    if (git && store.get().meta?.cwd === workspace) store.set({ git })
  },

  copy(text: string) {
    void guard(() => getMako().copy(text))
    toast.success("Copied")
  },
}
