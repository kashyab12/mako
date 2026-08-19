/**
 * Every session on this machine, from every harness, kept current.
 *
 * Speed comes from doing strictly bounded work at each layer:
 *
 *   * **Scan** stats files and re-peeks only the ones whose size or mtime
 *     moved — a thousand unchanged sessions cost a thousand stats and zero
 *     reads. The peek cache persists across runs, so a cold start with a
 *     warm cache does no reading at all.
 *   * **Watch** puts one recursive watcher on each harness root and re-peeks
 *     exactly the file that changed, debounced per path. Opening a Codex
 *     session in a terminal, another app, anywhere — shows up here within a
 *     debounce interval, because the file is the source of truth and the
 *     file is what is watched.
 *   * **Follow** tails one open thread by byte offset: a streaming agent
 *     costs one positional read of only the appended bytes per flush.
 */

import { existsSync, watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Thread, ThreadEntry, ThreadRef } from "./format.js"
import type { NativeFile, SessionProvider } from "./providers/types.js"
import { SessionArchive } from "./archive.js"

/**
 * A store that lives behind an API rather than on this disk (Devin). Same
 * shapes, listed by request instead of by walking directories, and kept
 * fresh by polling — the only watching a remote store offers.
 */
export interface RemoteSource {
  harness: string
  displayName: string
  owns(path: string): boolean
  list(): Promise<ThreadRef[]>
  read(path: string): Promise<Thread | null>
  send?(path: string, message: string): Promise<void>
}

export type CatalogEvent =
  | { type: "added"; ref: ThreadRef }
  | { type: "updated"; ref: ThreadRef }
  | { type: "removed"; path: string }

interface CacheEntry {
  bytes: number
  mtimeMs: number
  ref: ThreadRef | null
}

const WATCH_DEBOUNCE_MS = 200
const CACHE_SAVE_DEBOUNCE_MS = 2000

/** How often remote sources are re-listed while watching. */
const REMOTE_POLL_MS = 90_000

/** Faster, while someone is actually looking at a remote thread. */
const REMOTE_FOLLOW_MS = 15_000

/** Rescan cadence where recursive watching is unavailable. Stat-only. */
const POLL_FALLBACK_MS = 30_000

export class SessionCatalog {
  private providers: SessionProvider[]
  private remotes: RemoteSource[] = []
  private remoteRefs = new Map<string, ThreadRef>()
  private remoteTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private byPath = new Map<string, CacheEntry>()
  private cachePath?: string
  private cacheLoaded = false
  private saveTimer: NodeJS.Timeout | null = null
  private watchers: FSWatcher[] = []
  private pending = new Map<string, NodeJS.Timeout>()
  private listeners = new Set<(event: CatalogEvent) => void>()
  private follows = new Map<string, Set<(entries: ThreadEntry[], replaced: boolean) => void>>()
  private followOffsets = new Map<string, number>()

  private archive: SessionArchive | null = null

  constructor(
    providers: SessionProvider[],
    options: { cachePath?: string; archivePath?: string } = {}
  ) {
    this.providers = providers
    this.cachePath = options.cachePath
    if (options.archivePath) this.archive = new SessionArchive(options.archivePath)
  }

  /** Register a remote store. Included in every scan and poll from then on. */
  addRemote(remote: RemoteSource): void {
    this.remotes.push(remote)
  }

  /** The remote that owns a path, for callers that need to send through it. */
  remoteFor(path: string): RemoteSource | null {
    return this.remotes.find((remote) => remote.owns(path)) ?? null
  }

  /** Harness names served by remote sources (replyable through their API). */
  remoteHarnesses(): string[] {
    return [...new Set(this.remotes.map((remote) => remote.harness))]
  }

  /* ------------------------------------------------------------ scanning */

  /**
   * Reconcile the catalog with disk. Returns every known session, newest
   * first. By default emits nothing — scan is for building state; watch is
   * for changes — but the polling fallback (platforms without recursive
   * watch) passes `emitChanges` so its rescans behave like watch events.
   */
  async scan(options: { emitChanges?: boolean } = {}): Promise<ThreadRef[]> {
    await this.loadCache()
    await this.archive?.load()
    const seen = new Set<string>()
    await Promise.all(
      this.providers.map(async (provider) => {
        const files = await provider.discover().catch((): NativeFile[] => [])
        await Promise.all(
          files.map(async (file) => {
            seen.add(file.path)
            const cached = this.byPath.get(file.path)
            if (cached && cached.bytes === file.bytes && cached.mtimeMs === file.mtimeMs) return
            const ref = await provider.peek(file).catch(() => null)
            this.byPath.set(file.path, { bytes: file.bytes, mtimeMs: file.mtimeMs, ref })
            if (options.emitChanges && ref) {
              this.emit({ type: cached?.ref ? "updated" : "added", ref })
            }
          })
        )
      })
    )
    for (const path of this.byPath.keys()) {
      if (!seen.has(path)) this.byPath.delete(path)
    }
    this.scheduleSave()
    await this.pollRemotes()
    return this.list()
  }

  /** The known sessions, newest first, optionally narrowed to a workspace. */
  list(filter: { cwd?: string; harness?: string } = {}): ThreadRef[] {
    const refs: ThreadRef[] = []
    const admit = (ref: ThreadRef | null) => {
      if (!ref) return
      if (filter.harness && ref.harness !== filter.harness) return
      if (filter.cwd && ref.cwd !== filter.cwd) return
      refs.push(ref)
    }
    // One session, one row: the same conversation reachable through two
    // paths (symlinked stores, copied homes) keeps its freshest ref only.
    const byIdentity = new Map<string, ThreadRef>()
    for (const entry of this.byPath.values()) {
      const ref = entry.ref
      if (!ref) continue
      const key = `${ref.harness}:${ref.nativeId}`
      const held = byIdentity.get(key)
      if (!held || (ref.updatedAt ?? "") > (held.updatedAt ?? "")) byIdentity.set(key, ref)
    }
    for (const ref of byIdentity.values()) admit(ref)
    for (const ref of this.remoteRefs.values()) admit(ref)
    // Sessions whose native store forgot them. The archive did not.
    if (this.archive) {
      const live = new Set(this.byPath.keys())
      for (const ref of this.archive.orphans(live)) admit(ref)
    }
    return refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
  }

  /** Full translation of one session, via whichever store owns its path. */
  async open(path: string): Promise<Thread | null> {
    const remote = this.remoteFor(path)
    if (remote) return remote.read(path)
    const provider = this.ownerOf(path)
    const native = provider ? await provider.read(path).catch(() => null) : null
    if (native) return native
    // The native store cannot answer — deleted, pruned, or gone with a
    // machine. The archive is exactly for this moment.
    return this.archive ? this.archive.read(path) : null
  }

  /* ------------------------------------------------------------ watching */

  /**
   * Watch every harness root. Events fire for sessions created or grown by
   * *anything* — this app, the harness's own CLI, another wrapper entirely.
   */
  startWatching(): void {
    if (this.watchers.length > 0) return
    this.armRemotePolling()
    let unwatchable = false
    for (const provider of this.providers) {
      for (const root of provider.roots()) {
        if (!existsSync(root)) continue // Not installed: nothing to watch.
        try {
          const watcher = watch(root, { recursive: true }, (_event, filename) => {
            if (!filename) return
            this.noticed(`${root}/${filename.toString()}`)
          })
          watcher.on("error", () => {})
          this.watchers.push(watcher)
        } catch {
          // Recursive watching is unavailable on some platforms and network
          // volumes. Those roots fall back to the polling rescan below.
          unwatchable = true
        }
      }
    }
    if (unwatchable && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.scan({ emitChanges: true })
      }, POLL_FALLBACK_MS)
      this.pollTimer.unref?.()
    }
  }

  onEvent(listener: (event: CatalogEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Live entries for one open thread. For append-only stores the callback
   * receives only what was appended after `fromByte`; for stores that
   * rewrite in place (Cursor's SQLite) it receives the whole translated
   * conversation with `replaced` set, and the caller swaps rather than
   * appends. Returns an unsubscribe.
   */
  follow(
    path: string,
    fromByte: number,
    onEntries: (entries: ThreadEntry[], replaced: boolean) => void
  ): () => void {
    const set = this.follows.get(path) ?? new Set()
    set.add(onEntries)
    this.follows.set(path, set)
    if (!this.followOffsets.has(path)) this.followOffsets.set(path, fromByte)
    return () => {
      set.delete(onEntries)
      if (set.size === 0) {
        this.follows.delete(path)
        this.followOffsets.delete(path)
      }
    }
  }

  stop(): void {
    this.archive?.stop()
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    if (this.remoteTimer) {
      clearInterval(this.remoteTimer)
      this.remoteTimer = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      void this.saveCache()
    }
  }

  /* ------------------------------------------------------------ remotes */

  /**
   * Re-list every remote source and emit what moved. `updatedAt` is the
   * change signal a remote offers — there is no mtime to stat — so a ref
   * whose stamp moved is an update and a new path is an addition.
   */
  private async pollRemotes(): Promise<void> {
    if (this.remotes.length === 0) return
    await Promise.all(
      this.remotes.map(async (remote) => {
        const refs = await remote.list().catch((): ThreadRef[] => [])
        for (const ref of refs) {
          const previous = this.remoteRefs.get(ref.path)
          this.remoteRefs.set(ref.path, ref)
          if (!previous) this.emit({ type: "added", ref })
          else if (previous.updatedAt !== ref.updatedAt) this.emit({ type: "updated", ref })
        }
      })
    )
    // A followed remote thread refreshes wholesale — polling is its only tail.
    for (const [path, followers] of this.follows) {
      const remote = this.remoteFor(path)
      if (!remote || followers.size === 0) continue
      const thread = await remote.read(path).catch(() => null)
      if (thread) {
        for (const follower of followers) follower(thread.entries, true)
      }
    }
  }

  private armRemotePolling(): void {
    if (this.remoteTimer || this.remotes.length === 0) return
    let ticks = 0
    this.remoteTimer = setInterval(() => {
      ticks += 1
      const followingRemote = [...this.follows.keys()].some((path) => this.remoteFor(path))
      // The full re-list runs on the slow cadence; the fast cadence exists
      // only while someone is actually looking at a remote thread.
      if (followingRemote || ticks % Math.round(REMOTE_POLL_MS / REMOTE_FOLLOW_MS) === 0) {
        void this.pollRemotes()
      }
    }, REMOTE_FOLLOW_MS)
    this.remoteTimer.unref?.()
  }

  /* ------------------------------------------------------------ internals */

  private ownerOf(path: string): SessionProvider | null {
    for (const provider of this.providers) {
      if (provider.roots().some((root) => path.startsWith(`${root}/`) || path === root)) {
        return provider
      }
    }
    return null
  }

  private noticed(path: string): void {
    const provider = this.ownerOf(path)
    if (!provider) return
    clearTimeout(this.pending.get(path))
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path)
        void this.refresh(provider, path)
      }, WATCH_DEBOUNCE_MS)
    )
  }

  private async refresh(provider: SessionProvider, path: string): Promise<void> {
    const info = await stat(path).catch(() => null)
    if (!info || !info.isFile()) {
      if (this.byPath.delete(path)) {
        this.scheduleSave()
        this.emit({ type: "removed", path })
      }
      return
    }
    const file: NativeFile = { path, bytes: info.size, mtimeMs: info.mtimeMs }
    const cached = this.byPath.get(path)
    if (cached && cached.bytes === file.bytes && cached.mtimeMs === file.mtimeMs) return
    const ref = await provider.peek(file).catch(() => null)
    this.byPath.set(path, { bytes: file.bytes, mtimeMs: file.mtimeMs, ref })
    this.scheduleSave()
    if (ref) this.emit({ type: cached?.ref ? "updated" : "added", ref })

    const followers = this.follows.get(path)
    if (!followers || followers.size === 0) return
    if (provider.tail) {
      const from = this.followOffsets.get(path) ?? 0
      const { entries, nextByte } = await provider.tail(path, from).catch(() => ({
        entries: [] as ThreadEntry[],
        nextByte: from,
      }))
      this.followOffsets.set(path, nextByte)
      if (entries.length > 0) {
        for (const follower of followers) follower(entries, false)
      }
    } else {
      // The store rewrites in place; the honest live view is a re-read.
      const thread = await provider.read(path).catch(() => null)
      if (thread) {
        for (const follower of followers) follower(thread.entries, true)
      }
    }
  }

  private emit(event: CatalogEvent): void {
    // Every added or grown session is also recorded in the archive — the
    // copy that survives the native store. Lazy read, throttled inside.
    if (this.archive && (event.type === "added" || event.type === "updated")) {
      const ref = event.ref
      if (!ref.archived) this.archive.note(ref, () => this.open(ref.path))
    }
    for (const listener of this.listeners) listener(event)
  }

  /* ------------------------------------------------------------ cache */

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded || !this.cachePath) {
      this.cacheLoaded = true
      return
    }
    this.cacheLoaded = true
    try {
      const raw = await readFile(this.cachePath, "utf8")
      const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, CacheEntry> }
      if (parsed.version === 1 && parsed.entries) {
        for (const [path, entry] of Object.entries(parsed.entries)) {
          this.byPath.set(path, entry)
        }
      }
    } catch {
      // No cache yet, or an unreadable one: the scan simply peeks everything.
    }
  }

  private scheduleSave(): void {
    if (!this.cachePath || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveCache()
    }, CACHE_SAVE_DEBOUNCE_MS)
  }

  private async saveCache(): Promise<void> {
    if (!this.cachePath) return
    try {
      await mkdir(dirname(this.cachePath), { recursive: true })
      const entries: Record<string, CacheEntry> = {}
      for (const [path, entry] of this.byPath) entries[path] = entry
      await writeFile(this.cachePath, JSON.stringify({ version: 1, entries }), "utf8")
    } catch {
      // A failed cache write costs the next start a re-peek, nothing more.
    }
  }
}
