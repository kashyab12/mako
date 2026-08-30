import type {
  ThreadEntry as CatalogThreadEntry,
  ThreadRef as CatalogThreadRef,
} from "@mako/sessions"
import type {
  Automation,
  AutomationRun,
  UpdateState,
} from "./automations-usage-updates.js"
import type {
  ChatMessage,
  ModelInfo,
  SessionMeta,
  SessionState,
  ThreadRunState,
  TreeNode,
} from "./conversation-session.js"
import type { GitStatus } from "./git-workspace-search.js"
import type { Capabilities } from "./mcp-skills-integrations.js"
import type {
  AcpPermissionRequest,
  AcpSessionState,
  AcpUpdate,
} from "./providers-acp.js"

/**
 * The wire contract between the Electron host and the renderer.
 *
 * Design rule: the hot path (token streaming) must never re-send the whole
 * session. `stream` carries one message; `meta` carries scalars; the heavy
 * payloads (`messages`, `tree`, `git`) are emitted only when they change.
 */
export interface ExternalThreadActivity {
  provider: string
  since: number
  status: "active" | "needs-input"
  detail?: string
}

export type HostEventBody =
  | { type: "session"; session: SessionState }
  | { type: "meta"; meta: SessionMeta }
  | { type: "messages"; messages: ChatMessage[] }
  | { type: "stream"; message: ChatMessage | null }
  | { type: "tree"; tree: TreeNode[]; leafId: string | null }
  | { type: "git"; git: GitStatus }
  | { type: "capabilities"; capabilities: Capabilities }
  | { type: "notice"; level: "info" | "success" | "error"; message: string }
  /** The file open in the viewer changed on disk (any writer). */
  | { type: "file-changed"; path: string }
  /** A file in the plugins directory changed; the renderer should re-read them. */
  | { type: "plugins-changed" }
  /** Update progress. Window-wide, not tied to any tab. */
  | { type: "update"; update: UpdateState }
  | { type: "automations"; automations: Automation[] }
  | { type: "automation-run"; run: AutomationRun }
  /**
   * The cross-harness session catalog changed: a session somewhere on this
   * machine — from any app — was created or grew. Window-wide.
   */
  | { type: "threads"; threads: CatalogThreadRef[] }
  | { type: "thread-ref"; ref: CatalogThreadRef }
  | { type: "thread-removed"; path: string }
  | {
      type: "thread-activity"
      path: string
      activity: ExternalThreadActivity | null
    }
  /** New entries appended to the thread the viewer is following. */
  | {
      type: "thread-entries"
      path: string
      entries: CatalogThreadEntry[]
      replace?: boolean
      replaceFrom?: number
    }
  /** A native resume (the thread's own CLI) started, finished, or failed. */
  | { type: "thread-run"; run: ThreadRunState }
  /** An interactive (ACP) session changed state. */
  | { type: "acp-session"; session: AcpSessionState }
  /** One streamed piece, or one replay batch, from an interactive turn. */
  | { type: "acp-update"; id: string; update: AcpUpdate }
  | { type: "acp-updates"; id: string; updates: AcpUpdate[] }
  /** The interactive agent is asking to use a tool; the user must answer. */
  | { type: "acp-permission"; request: AcpPermissionRequest }

/**
 * Every event says which tab it came from.
 *
 * More than one agent runs at a time — that is the whole point of tabs — so an
 * untagged event would be applied to whichever conversation happens to be on
 * screen. Absent only on window-wide events like `plugins-changed`.
 */
export type HostEvent = HostEventBody & { tabId?: string }

/** Everything the renderer needs to draw one tab from cold. */
export interface TabSnapshot {
  id: string
  session: SessionState
  git: GitStatus
  capabilities: Capabilities
}

export interface BootPayload {
  /** Open tabs, in strip order. Always at least one. */
  tabs: TabSnapshot[]
  activeTabId: string
  models: ModelInfo[]
  platform: NodeJS.Platform
  /**
   * Where Mako's own source lives, when it is editable.
   *
   * Present only in development, where the renderer is served by Vite and an
   * edit to `src/` is hot-applied into the running window. A packaged build
   * has no source tree and no dev server, so pointing a session at it would
   * offer a change you could never see — the field is absent there, and the
   * feature hides itself.
   */
  sourceRoot?: string
}
