import type { TranscriptBundleMetadata } from "@mako/sessions"

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
  ThreadPage,
  ThreadRef,
  TurnUsage,
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

/** Full snapshot — sent on boot and whenever the branch/session is replaced. */
export interface SessionState {
  meta: SessionMeta
  messages: ChatMessage[]
  tree: TreeNode[]
}
