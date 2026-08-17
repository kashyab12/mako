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

export type HostEvent =
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

/** One workspace file, for the composer's `@` picker. */
export interface WorkspaceFile {
  /** Path relative to the git root (or cwd when not a repo). */
  path: string
  /** True when the file also appears in the working diff. */
  changed?: boolean
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
  session: SessionState
  git: GitStatus
  models: ModelInfo[]
  capabilities: Capabilities
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
