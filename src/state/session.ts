import { createHook, createStore, shallowEqual } from "@/state/store"
import type {
  Capabilities,
  GitStatus,
  HostEvent,
  ModelInfo,
  PiMessage,
  SessionMeta,
  SessionSummary,
  ThinkingLevel,
  TreeNode,
} from "@/lib/types"
import { getPi, hasBridge } from "@/lib/bridge"
import { reconcileMessages } from "@/lib/reconcile"
import { prefsStore } from "@/state/prefs"
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

function apply(event: HostEvent) {
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

export const actions = {
  async boot() {
    if (!hasBridge()) {
      store.set({
        phase: "detached",
        fault: "The Pi host is not attached. Launch the desktop app with `npm run desktop`.",
      })
      return () => {}
    }
    const pi = getPi()
    const unsubscribe = pi.onEvent(apply)
    try {
      const boot = await pi.boot()
      store.set({
        phase: "ready",
        meta: boot.session.meta,
        messages: boot.session.messages,
        tree: boot.session.tree,
        git: boot.git,
        models: boot.models,
        capabilities: boot.capabilities,
        platform: boot.platform,
        sourceRoot: boot.sourceRoot,
      })
      void actions.refreshSessions(boot.session.meta.cwd)
    } catch (error) {
      store.set({ phase: "detached", fault: error instanceof Error ? error.message : String(error) })
    }
    return unsubscribe
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
    store.set({ meta: next.meta, messages: next.messages, tree: next.tree, stream: null })
    void actions.refreshSessions(next.meta.cwd)
  },

  async openSession(path: string) {
    // Picking a thread means "show me that thread" — so any full-window view
    // standing in front of the transcript steps aside first.
    window.dispatchEvent(new CustomEvent("pi:close-settings"))
    const next = await guard(() => getPi().openSession(path))
    if (!next) return
    store.set({ meta: next.meta, messages: next.messages, tree: next.tree, stream: null })
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
    store.set({ meta: next.meta, messages: next.messages, tree: next.tree, stream: null })
    void actions.refreshSessions(folder)
    void actions.refreshModels()
  },

  async navigate(nodeId: string) {
    const next = await guard(() => getPi().navigateTree(nodeId))
    if (!next) return
    store.set({ meta: next.meta, messages: next.messages, tree: next.tree, stream: null })
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
