/**
 * Cross-harness threads, straight from @mako/sessions: every coding-agent
 * session on the machine, whichever app wrote it, in one shape.
 */
export type {
  EntryBlock,
  Harness,
  Thread,
  ThreadEntry,
  ThreadRef,
  TurnUsage,
} from "@mako/sessions"
import type { ThreadRef as CatalogThreadRef } from "@mako/sessions"

/**
 * The wire contract between the Electron host and the renderer.
 *
 * Design rule: the hot path (token streaming) must never re-send the whole
 * session. `stream` carries one message; `meta` carries scalars; the heavy
 * payloads (`messages`, `tree`, `git`) are emitted only when they change.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

export type ChatRole = "user" | "assistant" | "tool" | "system"

export type BlockType = "text" | "thinking" | "toolCall" | "toolResult" | "image"

export interface Block {
  type: BlockType
  text?: string
  thinking?: string
  /** Tool call / result correlation id. */
  id?: string
  name?: string
  arguments?: unknown
  mimeType?: string
  isError?: boolean
}

export interface PiMessage {
  id: string
  role: ChatRole
  blocks: Block[]
  timestamp?: number
  model?: string
  provider?: string
  error?: string
  toolName?: string
  toolCallId?: string
  isError?: boolean
  /** Set only on the in-flight assistant message. */
  streaming?: boolean
}

/**
 * One session entry, flat.
 *
 * Deliberately not nested. Pi stores a session as a parent-linked chain, so a
 * nested shape is exactly as deep as the session is long — 334 levels for 345
 * entries — and Electron's contextBridge refuses to clone anything past 1000.
 * A flat list with `parentId` carries the same information with no ceiling and
 * a smaller payload, and the renderer indexes it once.
 */
export interface TreeNode {
  id: string
  parentId: string | null
  type: string
  label?: string
  timestamp?: string
  preview: string
  role?: ChatRole
  /** True when this node sits on the path from a root to the live leaf. */
  onPath?: boolean
  childIds: string[]
}

export interface SessionSummary {
  path: string
  id: string
  cwd: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
}

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelInfo {
  provider: string
  id: string
  name: string
  reasoning: boolean
  /** Levels this exact model actually supports, in ascending order. */
  thinkingLevels: ThinkingLevel[]
  contextWindow: number
  maxTokens: number
  input: ("text" | "image")[]
  cost: ModelCost
}

export interface ContextUsage {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface TokenStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** Everything cheap enough to re-send on any state change. */
export interface SessionMeta {
  sessionId: string
  sessionFile?: string
  sessionName?: string
  cwd: string
  leafId: string | null
  model?: ModelInfo
  thinkingLevel: ThinkingLevel
  /** Levels the *current* model supports. Always includes "off". */
  thinkingLevels: ThinkingLevel[]
  isStreaming: boolean
  isIdle: boolean
  isCompacting: boolean
  isRetrying: boolean
  isBashRunning: boolean
  autoCompaction: boolean
  queued: { steering: string[]; followUp: string[] }
  cost: number
  tokens: TokenStats
  context?: ContextUsage
  messageCount: number
}

export interface ToolSummary {
  name: string
  description?: string
  active: boolean
  source?: string
}

export interface CommandSummary {
  name: string
  description?: string
  source?: string
}

export interface SkillSummary {
  name: string
  description: string
  source?: string
}

export interface Capabilities {
  tools: ToolSummary[]
  commands: CommandSummary[]
  skills: SkillSummary[]
}

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked"

/** Cheap per-file entry. Contents are fetched on demand via `git:diff`. */
export interface GitFile {
  path: string
  status: GitFileStatus
  oldName?: string
  insertions: number
  deletions: number
  binary: boolean
  staged: boolean
}

export interface GitStatus {
  cwd: string
  root?: string
  branch?: string
  /** HEAD's commit, so a commit can be noticed without a watcher of its own. */
  head?: string
  upstream?: string
  ahead: number
  behind: number
  files: GitFile[]
  /** True when a merge, rebase, or cherry-pick is in progress. */
  operation?: string
}

export interface GitCommitEntry {
  hash: string
  shortHash: string
  subject: string
  author: string
  /** ISO timestamp. */
  date: string
  /** Files touched, for the summary line. */
  files: number
  insertions: number
  deletions: number
}

export interface GitDiff {
  path: string
  binary: boolean
  oldFile: { name: string; contents: string } | null
  newFile: { name: string; contents: string } | null
}

/** Full snapshot — sent on boot and whenever the branch/session is replaced. */
export interface SessionState {
  meta: SessionMeta
  messages: PiMessage[]
  tree: TreeNode[]
}

export type HostEventBody =
  | { type: "session"; session: SessionState }
  | { type: "meta"; meta: SessionMeta }
  | { type: "messages"; messages: PiMessage[] }
  | { type: "stream"; message: PiMessage | null }
  | { type: "tree"; tree: TreeNode[]; leafId: string | null }
  | { type: "git"; git: GitStatus }
  | { type: "capabilities"; capabilities: Capabilities }
  | { type: "notice"; level: "info" | "success" | "error"; message: string }
  /** A file in the plugins directory changed; the renderer should re-read them. */
  | { type: "plugins-changed" }
  /** Update progress. Window-wide, not tied to any tab. */
  | { type: "update"; update: UpdateState }
  /** Dev server progress. Also window-wide: there is one project. */
  | { type: "devserver"; devserver: DevServerState }
  | { type: "automations"; automations: Automation[] }
  | { type: "automation-run"; run: AutomationRun }
  /**
   * The cross-harness session catalog changed: a session somewhere on this
   * machine — from any app — was created or grew. Window-wide.
   */
  | { type: "threads"; threads: CatalogThreadRef[] }

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

/** One workspace file, for the composer's `@` picker. */
export interface WorkspaceFile {
  /** Path relative to the git root (or cwd when not a repo). */
  path: string
  /** True when the file also appears in the working diff. */
  changed?: boolean
}

/**
 * Where the app is in the update cycle.
 *
 * `unsupported` is the normal state when running from a checkout: there is no
 * feed and never will be, and the UI should say that rather than sit on
 * "checking" forever. `ready` is the only state with a button attached — the
 * install is always a decision, never a surprise mid-turn.
 */
export interface UpdateState {
  status: "idle" | "checking" | "current" | "downloading" | "ready" | "error" | "unsupported"
  /** The version currently running. */
  version: string
  /** The version waiting, once there is one. */
  available?: string
  /** Download percentage, while downloading. */
  progress?: number
  notes?: string
  error?: string
}

/** Tokens and money, for one slice of history. */
export interface UsageTotals {
  cost: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  messages: number
}

/**
 * Where the money went.
 *
 * Spend, not billing: read from the session files, which already hold every
 * priced message. Billing means a payment method and an account model — a
 * server and a product decision, not something to imply with a currency
 * symbol.
 */
export interface UsageSummary {
  total: UsageTotals
  days: Array<{ date: string } & UsageTotals>
  models: Array<{ model: string } & UsageTotals>
  projects: Array<{ cwd: string } & UsageTotals>
  sessions: number
  /** True when older sessions were left unread to keep the scan quick. */
  truncated: boolean
}

/**
 * A saved prompt, with an optional trigger.
 *
 * `enabled` is local and never written to the shared file: an automation
 * arrives from a checkout with whatever its author set, and honouring that
 * would mean cloning a repository could start running an agent.
 */
export interface Automation {
  id: string
  name: string
  prompt: string
  trigger: "manual" | "files" | "commit"
  /** Globs, for the `files` trigger. `**` crosses directories, `*` does not. */
  paths: string[]
  enabled: boolean
}

export interface AutomationRun {
  id: string
  name: string
  reason: "manual" | "files" | "commit"
  at: number
}

/** A process listening on a TCP port, as far as `lsof` can see. */
export interface ListeningPort {
  port: number
  pid: number
  /** The owning process name, which is usually enough to recognise it. */
  command: string
  url: string
  /** Bound only to loopback, so nothing else on the network can reach it. */
  loopbackOnly: boolean
  /** Looks like a development server rather than background machinery. */
  likely: boolean
}

/**
 * The project's dev server, as far as this app knows.
 *
 * `failed` covers both "would not start" and "exited on its own", because for
 * something whose entire job is to keep running those are the same event from
 * the outside.
 */
export interface DevServerState {
  status: "idle" | "starting" | "running" | "stopping" | "failed"
  /** The npm script being run, when this app started it. */
  script?: string
  /** Where it is serving, once it has said so. */
  url?: string
  /** Recent output, capped. */
  lines: string[]
  exitCode?: number
}

/* ------------------------------------------------------------------ */
/* github                                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether GitHub is usable, and if not, which of three different problems it
 * is — a missing tool, a missing login, or a folder that is not a GitHub repo.
 * They want three different answers from the UI, so they are three fields.
 */
export interface GitHubStatus {
  installed: boolean
  authenticated: boolean
  login?: string
  /** `owner/name`, when this folder has a GitHub remote. */
  repo?: string
  defaultBranch?: string
}

export interface CheckSummary {
  name: string
  state: "passed" | "failed" | "running" | "unknown"
  url?: string
}

export interface ReviewSummary {
  login: string
  state: "approved" | "changes" | "commented"
}

export interface PullRequest {
  number: number
  title: string
  body: string
  state: "open" | "closed" | "merged"
  draft: boolean
  url: string
  head: string
  base: string
  additions: number
  deletions: number
  files: number
  mergeable: "clean" | "conflicting" | "unknown"
  reviewDecision: "approved" | "changes" | "required" | "none"
  author?: string
  updatedAt?: string
  checks: CheckSummary[]
  reviews: ReviewSummary[]
}

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  /** Treat the query as a regular expression rather than literal text. */
  regex?: boolean
  caseSensitive?: boolean
  /** Whole-word matching, as `\bfoo\b` would. */
  wholeWord?: boolean
  /** Search past conversations too, not only the working tree. */
  threads?: boolean
  /** Reach every project, or only this one. Threads only; files are per-workspace. */
  scope?: "workspace" | "all"
}

export interface SearchLine {
  line: number
  text: string
}

export interface FileMatches {
  /** Workspace-relative. */
  path: string
  lines: SearchLine[]
  /** Matches beyond the ones listed, so the UI can say so rather than lie. */
  more: number
}

export interface ThreadMatches {
  /** The session file, which is what `openSession` takes. */
  path: string
  title: string
  cwd: string
  modified: string
  lines: Array<{ role: ChatRole; text: string }>
  more: number
}

export interface SearchResults {
  query: string
  files: FileMatches[]
  threads: ThreadMatches[]
  /** Total matching lines found, including any not returned. */
  total: number
  /** True when the sweep hit a ceiling — the result set is not the whole truth. */
  truncated: boolean
  /** How long it took, in milliseconds. */
  elapsed: number
  /** Set when the query itself was the problem, e.g. an invalid regex. */
  error?: string
}

/** One workspace file, opened for reading. */
export interface FileContents {
  /** Workspace-relative, as it was asked for. */
  path: string
  contents: string
  /** Bytes on disk, not of `contents` — they differ when truncated. */
  size: number
  /** Not text. `contents` is empty; the viewer says so rather than rendering noise. */
  binary: boolean
  /** Only the head was read, because the whole file is too large to render. */
  truncated: boolean
}

/**
 * A file the agent cannot receive inline — a PDF, a video, an archive.
 * The host materializes it to disk and hands back a path, so Pi's own read
 * and bash tools can open it. That is what makes "attach anything" honest
 * rather than a silent drop.
 */
export interface StagedFile {
  path: string
  name: string
  size: number
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
