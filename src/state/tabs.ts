import { createHook, createStore } from "@/state/store"
import type {
  Capabilities,
  GitStatus,
  ChatMessage,
  SessionMeta,
  TabSnapshot,
  TreeNode,
} from "@/lib/types"

/**
 * The open conversations.
 *
 * One tab is on screen; the rest keep running in the background. This store
 * holds only what the tab strip draws — a title and whether the agent is still
 * working — because that is all that needs to re-render when a background tab
 * makes progress. The conversations themselves live in `cache`, which is a
 * plain map on purpose: nothing subscribes to it, so a background tab writing
 * to it costs no React work at all.
 */

export interface TabInfo {
  id: string
  title: string
  cwd: string
  /** The session file this tab holds, so the rail can find its row. */
  sessionFile?: string
  /** The agent is doing something — streaming, compacting, retrying, or in a shell. */
  working: boolean
  /** Waiting on the model right now, as opposed to running a tool. */
  streaming: boolean
  /** Finished, or spoke, while you were reading a different tab. */
  unread: boolean
}

interface TabActivity {
  working: boolean
  streaming: boolean
}

export interface TabPatch {
  title?: string
  cwd?: string
  working?: boolean
  streaming?: boolean
  unread?: boolean
}

interface TabsState {
  tabs: TabInfo[]
  activeId: string
}

/** Everything needed to draw a tab the instant it is selected. */
export interface TabCache {
  meta?: SessionMeta
  messages: ChatMessage[]
  stream: ChatMessage | null
  tree: TreeNode[]
  git?: GitStatus
  capabilities?: Capabilities
}

const emptyCache = (): TabCache => ({ messages: [], stream: null, tree: [] })

export const tabsStore = createStore<TabsState>({
  tabs: [],
  activeId: "",
})

export const useTabs = createHook(tabsStore)

const cache = new Map<string, TabCache>()
const MAX_BACKGROUND_CACHES = 2

function rememberCache(id: string, entry: TabCache): void {
  cache.delete(id)
  cache.set(id, entry)
  while (cache.size > MAX_BACKGROUND_CACHES) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

export function cacheOf(id: string): TabCache {
  let entry = cache.get(id)
  if (!entry) {
    entry = emptyCache()
    rememberCache(id, entry)
  } else {
    rememberCache(id, entry)
  }
  return entry
}

export function writeCache(id: string, patch: Partial<TabCache>) {
  rememberCache(id, { ...cacheOf(id), ...patch })
}

export function dropCache(id: string) {
  cache.delete(id)
}

/* ------------------------------------------------------------------ */
/* titles                                                              */
/* ------------------------------------------------------------------ */

const MAX_TITLE = 60

/**
 * What to call a tab.
 *
 * A named session uses its name. An unnamed one uses its opening question,
 * which is what people actually remember a conversation by — far better than
 * "Session 3" and better than the folder, since several tabs usually share a
 * folder.
 */
export function titleFor(
  meta: SessionMeta | undefined,
  messages: ChatMessage[]
): string {
  if (meta?.sessionName) return meta.sessionName
  const first = messages.find((message) => message.role === "user")
  const text = first?.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (text)
    return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text
  return "New thread"
}

function workingFrom(meta: SessionMeta | undefined): TabActivity {
  return {
    working: Boolean(
      meta &&
      (meta.isStreaming ||
        meta.isCompacting ||
        meta.isRetrying ||
        meta.isBashRunning)
    ),
    streaming: Boolean(meta?.isStreaming),
  }
}

/* ------------------------------------------------------------------ */
/* mutations                                                           */
/* ------------------------------------------------------------------ */

function infoFrom(id: string, entry: TabCache, previous?: TabInfo): TabInfo {
  return {
    id,
    title: titleFor(entry.meta, entry.messages),
    cwd: entry.meta?.cwd ?? previous?.cwd ?? "",
    sessionFile: entry.meta?.sessionFile ?? previous?.sessionFile,
    ...workingFrom(entry.meta),
    unread: previous?.unread ?? false,
  }
}

function sameTab(left: TabInfo, right: TabInfo): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.cwd === right.cwd &&
    left.sessionFile === right.sessionFile &&
    left.working === right.working &&
    left.streaming === right.streaming &&
    left.unread === right.unread
  )
}

export function hydrate(snapshots: TabSnapshot[], activeId: string) {
  cache.clear()
  const tabs = snapshots.map((snapshot) => {
    const entry: TabCache = {
      meta: snapshot.session.meta,
      messages: snapshot.session.messages,
      stream: null,
      tree: snapshot.session.tree,
      git: snapshot.git,
      capabilities: snapshot.capabilities,
    }
    if (snapshot.id !== activeId) rememberCache(snapshot.id, entry)
    return infoFrom(snapshot.id, entry)
  })
  tabsStore.set({ tabs, activeId })
}

export function addTab(snapshot: TabSnapshot, { activate = true } = {}) {
  const entry: TabCache = {
    meta: snapshot.session.meta,
    messages: snapshot.session.messages,
    stream: null,
    tree: snapshot.session.tree,
    git: snapshot.git,
    capabilities: snapshot.capabilities,
  }
  if (activate) dropCache(snapshot.id)
  else rememberCache(snapshot.id, entry)
  const { tabs, activeId } = tabsStore.get()
  if (tabs.some((tab) => tab.id === snapshot.id)) {
    refresh(snapshot.id, entry)
    if (activate) tabsStore.set({ activeId: snapshot.id })
    return
  }
  tabsStore.set({
    tabs: [...tabs, infoFrom(snapshot.id, entry)],
    activeId: activate ? snapshot.id : activeId,
  })
}

export function removeTab(id: string, nextActiveId: string) {
  dropCache(id)
  tabsStore.set((state) => ({
    tabs: state.tabs.filter((tab) => tab.id !== id),
    activeId: nextActiveId,
  }))
}

/**
 * Recompute one tab's strip entry.
 *
 * `source` is passed in rather than read from the cache because the tab you
 * are looking at keeps its conversation in the session store, not here — and a
 * title that only updated for background tabs would be a strange bug to chase.
 * Bails out when nothing changed, so a token arriving cannot repaint the strip.
 */
export function refresh(id: string, source: TabCache, patch: TabPatch = {}) {
  tabsStore.set((state) => {
    const index = state.tabs.findIndex((tab) => tab.id === id)
    const previous = state.tabs[index]
    if (!previous) return {}
    const next: TabInfo = { ...infoFrom(id, source, previous), ...patch }
    if (sameTab(previous, next)) return {}
    const tabs = [...state.tabs]
    tabs[index] = next
    return { tabs }
  })
}

/** Change strip fields directly, leaving the derived ones alone. */
export function patchTab(id: string, patch: TabPatch) {
  tabsStore.set((state) => {
    const index = state.tabs.findIndex((tab) => tab.id === id)
    const previous = state.tabs[index]
    if (!previous) return {}
    const next: TabInfo = { ...previous, ...patch }
    if (sameTab(previous, next)) return {}
    const tabs = [...state.tabs]
    tabs[index] = next
    return { tabs }
  })
}
