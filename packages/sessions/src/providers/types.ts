/**
 * What a harness must provide to join the catalog.
 *
 * The contract is file-shaped, not process-shaped: a provider knows where its
 * harness keeps sessions on disk, how to read one cheaply, and how to read
 * one fully. That is enough for the catalog to notice a session the moment
 * any app — this one, the harness's own TUI, someone else's wrapper — writes
 * to the store, which is what makes sync automatic rather than an import
 * button.
 */

import type { Harness, Thread, ThreadEntry, ThreadRef } from "../format.js"

/** A native session file as discovery sees it: a path and its stat facts. */
export interface NativeFile {
  path: string
  bytes: number
  mtimeMs: number
}

export interface SessionUpdate {
  entries: ThreadEntry[]
  nextByte: number
  replace: boolean
  replaceFrom?: number
  reset?: boolean
}

export interface SessionFollower {
  readonly offset: number
  next(): Promise<SessionUpdate>
}

export interface SessionProvider {
  harness: Harness
  displayName: string

  /**
   * True for stores where many sessions share one database file: a change
   * under the root cannot be stat-ed per session, so the catalog re-runs
   * discovery for this provider instead of refreshing one path.
   */
  rescanRoot?: boolean

  /**
   * Directories the harness writes sessions under. Used for discovery and
   * for watching; a root that does not exist simply contributes nothing.
   */
  roots(): string[]

  /** Every native session file under the roots, stat-only — no reads. */
  discover(): Promise<NativeFile[]>

  /**
   * The cheap read: enough of the file to identify the session — id, cwd,
   * title, when. Bounded I/O regardless of file size. Returns null for a
   * file that turns out not to be a session.
   */
  peek(file: NativeFile): Promise<ThreadRef | null>

  /** The full read: the whole conversation, translated. */
  read(path: string): Promise<Thread | null>

  /**
   * Incremental read for live sync: entries appended since `fromByte`, and
   * where to tail from next time. Providers whose store is not append-only
   * (Cursor's SQLite) fall back to a full re-read by omitting this.
   */
  createFollower?(path: string, fromByte: number): SessionFollower
  tail?(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }>
}
