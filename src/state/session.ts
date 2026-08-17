import { createHook, createStore, shallowEqual } from "@/state/store"
import type {
  Capabilities,
  GitStatus,
  HostEvent,
  ModelInfo,
  PiMessage,
  SessionMeta,
  SessionState,
  SessionSummary,
  ThinkingLevel,
  TreeNode,
} from "@/lib/types"
import { getPi, hasBridge } from "@/lib/bridge"
import { reconcileMessages } from "@/lib/reconcile"
import { prefsStore } from "@/state/prefs"
import {
  addTab,
  cacheOf,
  hydrate,
  patchTab,
  refresh,
  removeTab,
  tabsStore,
  writeCache,
} from "@/state/tabs"
import { viewer, viewerStore } from "@/state/viewer"
import { toast } from "sonner"

export type Phase = "booting" | "ready" | "detached"

export interface SessionStore {
  phase: Phase
  fault?: string
  meta?: SessionMeta
  messages: PiMessage[]
  /** The in-flight assistant message. Isolated so tokens touch one subtree. */
  stream: PiMessage | null
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
  if (event.tabId && (event.type === "meta" || event.type === "session" || event.type === "messages")) {
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
      writeCache(id, { git: event.git })
      break
    case "capabilities":
      writeCache(id, { capabilities: event.capabilities })
      break
    case "notice":
      // Errors from a hidden tab still surface — a failure you never see is
      // worse than an interruption — but they say which conversation raised it.
      if (event.level === "error") toast.error(event.message)
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
        messages: reconcileMessages(store.get().messages, event.session.messages),
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
      store.set({ messages: reconcileMessages(store.get().messages, event.messages) })
      break
    case "stream":
      store.set({ stream: event.message })
      break
    case "tree":
      store.set({ tree: event.tree })
      break
    case "git":
      store.set({ git: event.git })
      // The agent just wrote something. If it wrote the file you happen to be
      // reading, the version on screen is now wrong — and a stale file is
      // worse than no file, because nothing about it looks stale.
      followEdits(event.git)
      break
    case "capabilities":
      store.set({ capabilities: event.capabilities })
      break
    case "notice":
      if (event.level === "error") toast.error(event.message)
      else if (event.level === "success") toast.success(event.message)
      else toast(event.message)
      break
  }
}

/* ------------------------------------------------------------------ */
/* actions — every mutation the UI can perform, in one place           */
/* ------------------------------------------------------------------ */

function report(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error))
}

async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    report(error)
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
    refresh(id, { ...cacheOf(id), meta: next.meta, messages: next.messages }, { unread: false })
  }
}

export const actions = {
  async boot() {
    if (!hasBridge()) {
      store.set({
        phase: "detached",
        fault: "The agent host is not attached. Launch the desktop app with `npm run desktop`.",
      })
      return () => {}
    }
    const pi = getPi()
    const unsubscribe = pi.onEvent(apply)
    try {
      const boot = await pi.boot()
      hydrate(boot.tabs, boot.activeTabId)
      const active = boot.tabs.find((tab) => tab.id === boot.activeTabId) ?? boot.tabs[0]
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
    } catch (error) {
      store.set({ phase: "detached", fault: error instanceof Error ? error.message : String(error) })
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
    window.dispatchEvent(new CustomEvent("pi:close-settings"))
    await guard(() => getPi().activateTab(id))
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
    const tab = await guard(() => getPi().openTab(options))
    if (!tab) return
    addTab(tab)
    window.dispatchEvent(new CustomEvent("pi:close-settings"))
    store.set({
      meta: tab.session.meta,
      messages: tab.session.messages,
      stream: null,
      tree: tab.session.tree,
      git: tab.git,
      capabilities: tab.capabilities,
    })
    void actions.refreshSessions(tab.session.meta.cwd)
  },

  async closeTab(id: string) {
    const result = await guard(() => getPi().closeTab(id))
    if (!result) return
    const wasActive = tabsStore.get().activeId === id
    removeTab(id, result.activeId)
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
    patchTab(result.activeId, { unread: false })
    if (next.meta?.cwd) void actions.refreshSessions(next.meta.cwd)
  },

  async refreshSessions(cwd?: string, scope?: "workspace" | "all") {
    if (!hasBridge()) return
    store.set({ sessionsLoading: true })
    try {
      const next = await getPi().listSessions(
        cwd ?? store.get().meta?.cwd,
        scope ?? prefsStore.get().railScope
      )
      store.set({ sessions: next })
    } catch (error) {
      report(error)
    } finally {
      store.set({ sessionsLoading: false })
    }
  },

  async refreshModels() {
    const models = await guard(() => getPi().listModels())
    if (models) store.set({ models })
  },

  send(
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ) {
    return guard(() => getPi().prompt(text, mode, images))
  },

  abort() {
    return guard(() => getPi().abort())
  },

  clearQueue() {
    return guard(() => getPi().clearQueue())
  },

  async newSession() {
    window.dispatchEvent(new CustomEvent("pi:close-settings"))
    const next = await guard(() => getPi().newSession())
    if (!next) return
    adoptState(next)
    void actions.refreshSessions(next.meta.cwd)
  },

  /**
   * Show a thread. `inNewTab` keeps the current one running beside it, which is
   * what a modifier-click means everywhere else.
   */
  async openSession(path: string, { inNewTab = false } = {}) {
    // Already open somewhere? Go there. Two tabs on one session file would be
    // two views of one runtime fighting over it, and the rail giving you a
    // duplicate instead of the thing you can see is the wrong answer anyway.
    const existing = tabsStore.get().tabs.find((tab) => sessionFileOf(tab.id) === path)
    if (existing) return actions.switchTab(existing.id)
    if (inNewTab) return actions.openTab({ sessionPath: path })
    // Picking a thread means "show me that thread" — so any full-window view
    // standing in front of the transcript steps aside first.
    window.dispatchEvent(new CustomEvent("pi:close-settings"))
    const next = await guard(() => getPi().openSession(path))
    if (!next) return
    adoptState(next)
    void actions.refreshSessions(next.meta.cwd)
  },

  async pickWorkspace() {
    const folder = await guard(() => getPi().pickFolder())
    if (folder) await actions.openWorkspace(folder)
  },

  /** Point the agent at a folder by path, without a dialog. */
  async openWorkspace(folder: string) {
    const next = await guard(() => getPi().setCwd(folder))
    if (!next) return
    adoptState(next)
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
  async fork(entryId: string) {
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
    const result = await guard(() => getPi().fork(entryId))
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
      window.dispatchEvent(new CustomEvent("pi:compose", { detail: result.text }))
    }
  },

  async navigate(nodeId: string) {
    const next = await guard(() => getPi().navigateTree(nodeId))
    if (!next) return
    adoptState(next)
  },

  rename(name: string) {
    return guard(() => getPi().setName(name))
  },

  setModel(provider: string, id: string) {
    return guard(() => getPi().setModel(provider, id))
  },

  setThinking(level: ThinkingLevel) {
    return guard(() => getPi().setThinking(level))
  },

  compact(instructions?: string) {
    return guard(() => getPi().compact(instructions))
  },

  setAutoCompaction(enabled: boolean) {
    return guard(() => getPi().setAutoCompaction(enabled))
  },

  setActiveTools(names: string[]) {
    return guard(() => getPi().setActiveTools(names))
  },

  runCommand(name: string, args?: string) {
    return guard(() => getPi().runCommand(name, args))
  },

  async refreshGit() {
    const git = await guard(() => getPi().gitStatus())
    if (git) store.set({ git })
  },

  copy(text: string) {
    void guard(() => getPi().copy(text))
    toast.success("Copied")
  },
}
