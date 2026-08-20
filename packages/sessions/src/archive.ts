/**
 * The archive: Mako's own copy of every conversation it has ever seen.
 *
 * Native stores are other programs' property. CLIs prune them, users clear
 * them, laptops die — and with them every session that ever lived there.
 * The archive is the answer the catalog gives to that: each session it
 * sees is also recorded here, in the *canonical* shape — user turns,
 * assistant turns, tool calls, reasoning — which is precisely the shape
 * the emitters replay from. A session whose native file is gone is still
 * readable here, and still movable to any harness.
 *
 * Why a canonical copy rather than byte-for-byte native copies: bytes
 * preserve one harness's past; the canonical stream preserves the
 * *conversation*, portable to every harness including ones that do not
 * exist yet. It is also a fraction of the size of Cursor's SQLite or a
 * cold Codex rollout.
 *
 * Durability discipline:
 *   - One directory per session, keyed by a hash of its native path.
 *   - Every file written whole to a temp name and renamed into place —
 *     a crash mid-write leaves the previous complete version, never a
 *     torn one.
 *   - Writes are throttled per session (a streaming turn fires watcher
 *     events continuously; archiving needs the settled state, not every
 *     frame) and serialized through one queue so the disk sees calm,
 *     ordered IO.
 */

import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Thread, ThreadEntry, ThreadRef } from "./format.js"

/** At most one archive write per session per this window while it grows. */
const THROTTLE_MS = 15_000
/** The settle delay after the last change before the final write. */
const SETTLE_MS = 3_000

interface PersistedArchiveState {
  /** Native size at the time of the last write, to skip no-op syncs. */
  bytes?: number
  updatedAt?: string
  entryCount: number
}

export class SessionArchive {
  private root: string
  /** path → archived ref; the in-memory index behind synchronous list(). */
  private index = new Map<string, ThreadRef>()
  private states = new Map<string, PersistedArchiveState>()
  private loaded: Promise<void> | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private lastWrite = new Map<string, number>()
  private queue: Promise<void> = Promise.resolve()

  constructor(root: string) {
    this.root = root
  }

  /** Read every archived ref into memory. Idempotent; called once. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const dirs: string[] = await readdir(this.root).catch(() => [])
      await Promise.all(
        dirs.map(async (dir) => {
          try {
            const raw = await readFile(join(this.root, dir, "ref.json"), "utf8")
            const ref: ThreadRef = JSON.parse(raw)
            if (ref?.path)
              this.index.set(ref.path, {
                ...ref,
                locked: false,
                archived: true,
              })
            const state = await readFile(join(this.root, dir, "state.json"), "utf8").catch(
              () => null
            )
            if (state) {
              const persisted: PersistedArchiveState = JSON.parse(state)
              this.states.set(ref.path, persisted)
            }
          } catch {
            // A torn directory contributes nothing; the next sync heals it.
          }
        })
      )
    })()
    return this.loaded
  }

  /**
   * Sessions that exist only here any more — their native file is gone,
   * but the conversation is not.
   */
  orphans(livePaths: ReadonlySet<string>): ThreadRef[] {
    const result: ThreadRef[] = []
    for (const [path, ref] of this.index) {
      if (!livePaths.has(path)) result.push(ref)
    }
    return result
  }

  has(path: string): boolean {
    return this.index.has(path)
  }

  /**
   * Record a session, throttled. `readThread` is called lazily — only when
   * the throttle admits the write — so a burst of watcher events costs one
   * read, not fifty.
   */
  note(ref: ThreadRef, readThread: () => Promise<Thread | null>): void {
    const path = ref.path
    const state = this.states.get(path)
    // Unchanged since the last write: nothing to do, no read spent.
    if (state && state.bytes === ref.bytes && state.updatedAt === ref.updatedAt) return

    const existing = this.timers.get(path)
    if (existing) clearTimeout(existing)
    const since = Date.now() - (this.lastWrite.get(path) ?? 0)
    const delay = since >= THROTTLE_MS ? SETTLE_MS : THROTTLE_MS - since
    const timer = setTimeout(() => {
      this.timers.delete(path)
      this.enqueue(ref, readThread)
    }, delay)
    timer.unref?.()
    this.timers.set(path, timer)
  }

  /** The archived conversation, for when the native store cannot answer. */
  async read(path: string): Promise<Thread | null> {
    await this.load()
    const ref = this.index.get(path)
    if (!ref) return null
    try {
      const raw = await readFile(join(this.dirOf(path), "entries.jsonl"), "utf8")
      const entries = raw
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const entry: ThreadEntry = JSON.parse(line)
            return [entry]
          } catch {
            return []
          }
        })
      return { ref, entries }
    } catch {
      return null
    }
  }

  /** Drop one session from the archive. Only ever user-initiated. */
  async forget(path: string): Promise<void> {
    this.index.delete(path)
    this.states.delete(path)
    await rm(this.dirOf(path), { recursive: true, force: true }).catch(() => {})
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /* ------------------------------------------------------------ writing */

  private enqueue(ref: ThreadRef, readThread: () => Promise<Thread | null>): void {
    this.queue = this.queue.then(() => this.write(ref, readThread)).catch(() => {})
  }

  private async write(ref: ThreadRef, readThread: () => Promise<Thread | null>): Promise<void> {
    await this.load()
    const thread = await readThread().catch(() => null)
    if (!thread || thread.entries.length === 0) return
    const previous = this.states.get(ref.path)
    // The conversation did not grow; only refresh the ref metadata (title,
    // model, activity) which is one small atomic file.
    const dir = this.dirOf(ref.path)
    await mkdir(dir, { recursive: true })
    if (!previous || thread.entries.length !== previous.entryCount) {
      const body = thread.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
      await this.atomically(join(dir, "entries.jsonl"), body)
    }
    await this.atomically(join(dir, "ref.json"), JSON.stringify(thread.ref))
    const state: PersistedArchiveState = {
      bytes: ref.bytes,
      updatedAt: ref.updatedAt,
      entryCount: thread.entries.length,
    }
    await this.atomically(join(dir, "state.json"), JSON.stringify(state))
    this.states.set(ref.path, state)
    this.index.set(ref.path, {
      ...thread.ref,
      locked: false,
      archived: true,
    })
    this.lastWrite.set(ref.path, Date.now())
  }

  private async atomically(path: string, body: string): Promise<void> {
    const temp = `${path}.tmp`
    await writeFile(temp, body, "utf8")
    await rename(temp, path)
  }

  private dirOf(path: string): string {
    return join(this.root, createHash("sha1").update(path).digest("hex").slice(0, 24))
  }
}
