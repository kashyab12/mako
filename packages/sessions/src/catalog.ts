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

import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Thread, ThreadEntry, ThreadRef } from "./format.js"
import type { NativeFile, SessionProvider } from "./providers/types.js"

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

export class SessionCatalog {
  private providers: SessionProvider[]
  private byPath = new Map<string, CacheEntry>()
  private cachePath?: string
  private cacheLoaded = false
  private saveTimer: NodeJS.Timeout | null = null
  private watchers: FSWatcher[] = []
  private pending = new Map<string, NodeJS.Timeout>()
  private listeners = new Set<(event: CatalogEvent) => void>()
  private follows = new Map<string, Set<(entries: ThreadEntry[], replaced: boolean) => void>>()
  private followOffsets = new Map<string, number>()

  constructor(providers: SessionProvider[], options: { cachePath?: string } = {}) {
    this.providers = providers
    this.cachePath = options.cachePath
  }

  /* ------------------------------------------------------------ scanning */

  /**
   * Reconcile the catalog with disk. Returns every known session, newest
   * first. Emits nothing — scan is for building state; watch is for changes.
   */
  async scan(): Promise<ThreadRef[]> {
    await this.loadCache()
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
          })
        )
      })
    )
    for (const path of this.byPath.keys()) {
      if (!seen.has(path)) this.byPath.delete(path)
    }
    this.scheduleSave()
    return this.list()
  }

  /** The known sessions, newest first, optionally narrowed to a workspace. */
  list(filter: { cwd?: string; harness?: string } = {}): ThreadRef[] {
    const refs: ThreadRef[] = []
    for (const entry of this.byPath.values()) {
      if (!entry.ref) continue
      if (filter.harness && entry.ref.harness !== filter.harness) continue
      if (filter.cwd && entry.ref.cwd !== filter.cwd) continue
      refs.push(entry.ref)
    }
    return refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
  }

  /** Full translation of one session, via whichever provider owns its path. */
  async open(path: string): Promise<Thread | null> {
    const provider = this.ownerOf(path)
    return provider ? provider.read(path) : null
  }

  /* ------------------------------------------------------------ watching */

  /**
   * Watch every harness root. Events fire for sessions created or grown by
   * *anything* — this app, the harness's own CLI, another wrapper entirely.
   */
  startWatching(): void {
    if (this.watchers.length > 0) return
    for (const provider of this.providers) {
      for (const root of provider.roots()) {
        try {
          const watcher = watch(root, { recursive: true }, (_event, filename) => {
            if (!filename) return
            this.noticed(`${root}/${filename.toString()}`)
          })
          watcher.on("error", () => {})
          this.watchers.push(watcher)
        } catch {
          // A harness that is not installed has no root to watch.
        }
      }
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
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      void this.saveCache()
    }
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
