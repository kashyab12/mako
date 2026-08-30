import type {
  ExternalThreadActivity,
  Thread,
  ThreadEntry,
  ThreadRef,
  ThreadRunState,
} from "@/lib/types"
import type { ThreadStatus } from "@/state/thread-status"

export interface HarnessOptionValues {
  [option: string]: string | boolean
}

export interface ComposerTuning {
  model?: string
  effort?: string
  fast?: boolean
  options?: HarnessOptionValues
}

interface ComposerTuningByHarness {
  [harness: string]: ComposerTuning
}

interface WorkingThreadsByPath {
  [path: string]: Extract<ThreadStatus, { kind: "working" }>
}

export interface AttentionByPath {
  [path: string]: Extract<
    ThreadStatus,
    { kind: "needs-permission" | "failed" | "review" }
  >
}

interface QueuedReply {
  ref: ThreadRef
  prompts: string[]
}

interface QueuedRepliesByPath {
  [path: string]: QueuedReply
}

export type ViewedUserEntry = Extract<ThreadEntry, { kind: "user" }> & {
  echo?: boolean
}
export type ViewedThreadEntry =
  | ViewedUserEntry
  | Exclude<ThreadEntry, { kind: "user" }>

export interface ViewedThread extends Omit<Thread, "entries"> {
  entries: ViewedThreadEntry[]
  pageStart: number
  totalEntries: number
  hasEarlier: boolean
  loadingEarlier?: boolean
  streamRevision?: number
  streamReplaceFrom?: number
}

/**
 * Every coding agent's sessions on this machine — not just this app's.
 *
 * The host watches every configured provider's native store and pushes the
 * merged catalog here. Nothing in this store polls: a session grown by a
 * terminal on the other monitor
 * arrives as an event, the same way a streaming token does.
 */
export interface ThreadsState {
  threads: ThreadRef[]
  loaded: boolean
  /** The foreign thread open in the viewer overlay, if any. */
  viewing: ViewedThread | null
  opening: ThreadRef | null
  viewingBusy: boolean
  /** Harnesses whose CLI can be driven headlessly from here. */
  resumable: string[]
  /** Harnesses a conversation can be continued on. */
  targets: string[]
  /** Harnesses that can be driven interactively (ACP). */
  acpable: string[]
  /** The native run for the viewed thread, if one was started. */
  run: ThreadRunState | null
  /** Every live run owned by Mako, with its start and current operation. */
  working: WorkingThreadsByPath
  /** Persistent outcomes that must remain visible after the process stops. */
  attention: AttentionByPath
  /** Threads actively writing in another client, inferred from native-store events. */
  observed: Record<string, boolean>
  externalActivity: Record<string, ExternalThreadActivity>
  /** A translation in flight: one conversation becoming another harness's. */
  converting: { from: string; to: string; title?: string; done: boolean } | null
  /** The composer's chosen harness for new conversations. */
  composerHarness: string
  /** Per-harness tuning chosen in the composer. */
  composerTuning: ComposerTuningByHarness
  /** Prompts waiting for a thread's current run to end, per path. */
  queuedReplies: QueuedRepliesByPath
}
