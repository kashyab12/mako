/**
 * Cross-harness threads, straight from @mako/sessions: every coding-agent
 * session on the machine, whichever app wrote it, in one shape.
 */
export type {
  EntryBlock,
  Harness,
  Thread,
  ThreadEntry,
  ThreadOrigin,
  ThreadRef,
  TurnUsage,
} from "@mako/sessions"
import type {
  ThreadEntry as CatalogThreadEntry,
  ThreadRef as CatalogThreadRef,
  TranscriptBundleMetadata,
} from "@mako/sessions"

/** How referenced conversations cross the host boundary. */
export interface ThreadContextOptions {
  /** Inline delivery is for remote agents that cannot access this machine. */
  inline?: boolean
}

export interface ThreadFileContext {
  kind: "file"
  file: string
  title?: string
  harness: string
  metadata: TranscriptBundleMetadata
}

export interface ThreadInlineContext {
  kind: "inline"
  content: string
  title?: string
  harness: string
  metadata: TranscriptBundleMetadata
}

/** One headless run of a thread's own CLI, keyed by the thread's path. */
export interface ThreadRunState {
  path: string
  harness: string
  status: "running" | "done" | "failed" | "stopped"
  error?: string
}

export interface HarnessSelectValue {
  value: string
  label: string
  description?: string
  default?: boolean
}

export type HarnessModelOption =
  | {
      kind: "select"
      id: string
      label: string
      current?: string
      values: HarnessSelectValue[]
      presentation?: "select" | "toggle"
    }
  | {
      kind: "boolean"
      id: string
      label: string
      current: boolean
    }

export interface HarnessModelVariant {
  id: string
  label: string
  values: Record<string, string | boolean>
  contextWindow?: number
  maxOutputTokens?: number
  description?: string
}

export interface HarnessModel {
  /** Stable exact identity shown and persisted by Mako. */
  id: string
  /** Value the provider transport accepts when it differs from identity. */
  launchId?: string
  label: string
  description?: string
  aliases?: string[]
  contextWindow?: number
  maxOutputTokens?: number
  options: HarnessModelOption[]
  /** Flattened provider variants for transports that encode options in the model id. */
  variants?: HarnessModelVariant[]
}

export interface HarnessProfile {
  id: string
  label: string
  available: boolean
  transport: "acp" | "app-server" | "remote"
  models: HarnessModel[]
  defaultModel?: string
  configuredModel?: string
  capabilities: string[]
  error?: string
}

/* ------------------------------------------------------------------ */
/* MCP servers                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Interactive foreign agents (ACP)                                    */
/* ------------------------------------------------------------------ */

export interface AcpSessionState {
  id: string
  harness: string
  cwd: string
  title?: string
  status: "starting" | "ready" | "running" | "failed" | "closed"
  modes: Array<{ id: string; name: string }>
  currentMode: string | null
  configOptions: HarnessModelOption[]
  lastStop?: string
  error?: string
}

/** One streamed piece of an interactive turn, reduced for rendering. */
export type AcpUpdate =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool"
      id: string
      title: string
      toolKind?: string
      status: string
      input?: string
    }
  | {
      kind: "tool-update"
      id: string
      title?: string
      status?: string
      input?: string
      output?: string
    }
  | { kind: "plan"; entries: Array<{ content: string; status: string }> }

export interface AcpPromptAttachment {
  name: string
  mimeType: string
  size: number
  data?: string
  path?: string
}

export interface AcpInputQuestion {
  id: string
  header: string
  question: string
  isSecret: boolean
  allowOther: boolean
  options: Array<{ label: string; description: string }>
}

export interface AcpPermissionRequest {
  id: string
  sessionId: string
  title: string
  kind?: string
  options: Array<{ optionId: string; name: string; kind?: string }>
  questions?: AcpInputQuestion[]
}

export type AcpPermissionResponse =
  | { kind: "choice"; optionId: string | null }
  | { kind: "answers"; answers: Record<string, string[]> }

/**
 * The wire contract between the Electron host and the renderer.
 *
 * Design rule: the hot path (token streaming) must never re-send the whole
 * session. `stream` carries one message; `meta` carries scalars; the heavy
 * payloads (`messages`, `tree`, `git`) are emitted only when they change.
 */

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

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

export type BlockType =
  "text" | "thinking" | "toolCall" | "toolResult" | "image"

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

export interface ChatMessage {
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
 * Deliberately not nested. The engine stores a session as a parent-linked chain, so a
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

export type SkillProvider = McpProvider | "agents"
export type SkillScope = "user" | "workspace"

export interface SkillOrigin {
  provider: SkillProvider
  account: string
  scope: SkillScope
  provenance: string
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  hash: string
  bytes: number
  files: number
  portable: boolean
  origins: SkillOrigin[]
  license?: string
  compatibility?: string
  allowedTools?: string[]
  blockReason?: string
  conflict?: "name" | "drift"
}

export interface SkillProviderStatus {
  id: Exclude<SkillProvider, "agents">
  label: string
  account: string
  available: boolean
}

export interface SkillRegistrySnapshot {
  cwd: string
  generatedAt: number
  skills: SkillRecord[]
  providers: SkillProviderStatus[]
}

export interface SkillSyncTarget {
  provider: Exclude<SkillProvider, "agents">
  account: string
  scope: SkillScope
}

export interface SkillSyncPreview {
  skillId: string
  target: SkillSyncTarget
  action: "add" | "replace" | "remove" | "unchanged" | "blocked"
  summary: string
  blockReason?: string
}

export interface Capabilities {
  tools: ToolSummary[]
  commands: CommandSummary[]
  skills: SkillSummary[]
}

export type GitFileStatus =
  "added" | "modified" | "deleted" | "renamed" | "untracked"

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
  messages: ChatMessage[]
  tree: TreeNode[]
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
  /** Dev server progress. Also window-wide: there is one project. */
  | { type: "devserver"; devserver: DevServerState }
  | { type: "automations"; automations: Automation[] }
  | { type: "automation-run"; run: AutomationRun }
  /**
   * The cross-harness session catalog changed: a session somewhere on this
   * machine — from any app — was created or grew. Window-wide.
   */
  | { type: "threads"; threads: CatalogThreadRef[] }
  | { type: "thread-ref"; ref: CatalogThreadRef }
  | { type: "thread-removed"; path: string }
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
  status:
    | "idle"
    | "checking"
    | "current"
    | "downloading"
    | "ready"
    | "error"
    | "unsupported"
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
export type AutomationTrigger =
  | { kind: "manual" }
  | {
      kind: "files"
      /** Globs, for the `files` trigger. `**` crosses directories, `*` does not. */
      paths: string[]
    }
  | { kind: "commit" }
  | {
      kind: "slack"
      event: "message_in_channel" | "reaction_added" | "channel_created"
      channels: string[]
      messageFilter?: string
    }
  | {
      kind: "gmail"
      event: "message_received"
      from: string[]
      to: string[]
      subjectFilter?: string
      labels: string[]
      hasAttachment: boolean
    }
  | {
      kind: "google_calendar"
      event:
        | "event_created"
        | "event_updated"
        | "event_cancelled"
        | "event_starting_soon"
        | "event_ended"
      calendars: string[]
      titleFilter?: string
    }
  | { kind: "webhook"; path: string }

export function automationTriggerAvailable(
  trigger: AutomationTrigger
): boolean {
  return (
    trigger.kind === "manual" ||
    trigger.kind === "files" ||
    trigger.kind === "commit"
  )
}

export interface Automation {
  id: string
  name: string
  prompt: string
  trigger: AutomationTrigger
  enabled: boolean
}

export interface AutomationRun {
  id: string
  name: string
  reason: AutomationTrigger["kind"]
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
 * The host materializes it to disk and hands back a path, so engine-owned read
 * and shell tools can open it. That is what makes "attach anything" honest
 * rather than a silent drop.
 */
export interface StagedFile {
  path: string
  name: string
  size: number
}

export type McpProvider = "claude" | "cursor" | "devin" | "codex" | "grok"
export type McpTransport = "stdio" | "http" | "sse"
export type McpScope = "user" | "workspace" | "effective" | "managed"

export interface McpRegistryProviderStatus {
  id: McpProvider
  label: string
  account: string
  available: boolean
  source: string
  detail?: string
}

export interface McpServerDefinition {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  envNames: string[]
  headerNames: string[]
  portable: boolean
  blockReason?: string
}

export interface McpServerOrigin {
  provider: McpProvider | "mako"
  account: string
  scope: McpScope
  provenance: string
}

export interface McpServerRecord extends McpServerDefinition {
  id: string
  origins: McpServerOrigin[]
  conflict?: "name" | "drift"
  availability?: "available" | "unavailable" | "unknown"
  detail?: string
  managed?: boolean
}

export interface McpRegistrySnapshot {
  cwd: string
  generatedAt: number
  servers: McpServerRecord[]
  providers: McpRegistryProviderStatus[]
}

export interface MakoComputerPermissions {
  supported: boolean
  accessibility: boolean
  screenRecording: "not-determined" | "denied" | "restricted" | "granted" | "unknown"
}

export type IntegrationCategory =
  | "Communication"
  | "Planning"
  | "Development"
  | "Productivity"
  | "Local"

export type IntegrationConnection =
  | { kind: "connected"; detail: string; providers: McpProvider[] }
  | { kind: "ready"; detail: string }
  | { kind: "needs-permission"; detail: string }
  | { kind: "setup"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "conflict"; detail: string }

export interface IntegrationRecord {
  id: string
  label: string
  description: string
  category: IntegrationCategory
  trust: "official" | "mako" | "community"
  auth: "provider-oauth" | "provider-cli" | "local-permission"
  capabilities: string[]
  events: string[]
  connection: IntegrationConnection
  setupUrl?: string
}

export interface IntegrationCatalogSnapshot {
  generatedAt: number
  integrations: IntegrationRecord[]
}

export interface McpSyncTarget {
  provider: McpProvider
  account: string
  scope: "user" | "workspace"
}

export interface McpSyncPreview {
  serverId: string
  target: McpSyncTarget
  action: "add" | "replace" | "unchanged" | "blocked"
  summary: string
  blockReason?: string
}

export type TerminalSessionStatus = "running" | "exited" | "interrupted"

export interface TerminalSession {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  status: TerminalSessionStatus
  cols: number
  rows: number
  sequence: number
  exitCode?: number
}

export interface TerminalSnapshot {
  session: TerminalSession
  data: string
  sequence: number
}

export type TerminalEvent =
  | { type: "connection"; state: "connecting" | "ready" | "disconnected"; error?: string }
  | { type: "wake" }
  | { type: "snapshot"; snapshot: TerminalSnapshot }
  | { type: "output"; sessionId: string; sequence: number; data: string }
  | { type: "status"; session: TerminalSession }
  | { type: "removed"; sessionId: string }

export interface TerminalCreateOptions {
  cwd: string
  title?: string
  cols: number
  rows: number
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
