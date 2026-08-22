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

import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Thread, ThreadEntry, ThreadOrigin, ThreadRef } from "./format.js"
import type {
  NativeFile,
  SessionFollower,
  SessionProvider,
  SessionUpdate,
} from "./providers/types.js"
import { SessionArchive } from "./archive.js"

export type CatalogEvent =
  | { type: "added"; ref: ThreadRef }
  | { type: "updated"; ref: ThreadRef }
  | { type: "removed"; path: string }

interface CacheEntry {
  bytes: number
  mtimeMs: number
  ref: ThreadRef | null
}

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

interface FollowState {
  listeners: Set<
    (entries: ThreadEntry[], replaced: boolean, replaceFrom?: number) => void
  >
  follower: SessionFollower | null
  fromByte: number
  baselineCount: number | null
}

interface RefreshState {
  requested: boolean
  promise: Promise<void>
}

const WATCH_DEBOUNCE_MS = 24
const CACHE_SAVE_DEBOUNCE_MS = 2000

/** Rescan cadence where recursive watching is unavailable. Stat-only. */
const POLL_FALLBACK_MS = 30_000
const workspaceRoots = new Map<string, string>()

function workspaceOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const cached = workspaceRoots.get(cwd)
  if (cached) return cached
  let path = cwd
  try {
    path = realpathSync(cwd)
  } catch {
    while (path.length > 1 && /[\\/]$/.test(path)) path = path.slice(0, -1)
  }
  let cursor = path
  while (cursor !== dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      workspaceRoots.set(cwd, cursor)
      return cursor
    }
    cursor = dirname(cursor)
  }
  workspaceRoots.set(cwd, path)
  return path
}

function withWorkspace(ref: ThreadRef | null): ThreadRef | null {
  if (!ref) return null
  const workspace = workspaceOf(ref.cwd)
  return workspace && workspace !== ref.workspace
    ? { ...ref, workspace }
    : ref
}

function withThreadWorkspace(thread: Thread | null): Thread | null {
  if (!thread) return null
  const ref = withWorkspace(thread.ref)
  return ref === thread.ref || !ref ? thread : { ...thread, ref }
}

export class SessionCatalog {
  private providers: SessionProvider[]
  private pollTimer: NodeJS.Timeout | null = null
  private byPath = new Map<string, CacheEntry>()
  private cachePath?: string
  private cacheLoaded = false
  private saveTimer: NodeJS.Timeout | null = null
  private watchers: FSWatcher[] = []
  private pending = new Map<string, NodeJS.Timeout>()
  private listeners = new Set<(event: CatalogEvent) => void>()
  private follows = new Map<string, FollowState>()
  private refreshes = new Map<string, RefreshState>()
  private rescans = new Map<string, RefreshState>()
  private opened: {
    path: string
    throughByte: number
    entryCount: number
  } | null = null
  private threadCache: {
    path: string
    bytes: number
    mtimeMs: number
    thread: Thread
  } | null = null

  private archive: SessionArchive | null = null

  constructor(
    providers: SessionProvider[],
    options: { cachePath?: string; archivePath?: string } = {}
  ) {
    this.providers = providers
    this.cachePath = options.cachePath
    if (options.archivePath)
      this.archive = new SessionArchive(options.archivePath)
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
            if (
              cached &&
              cached.bytes === file.bytes &&
              cached.mtimeMs === file.mtimeMs
            )
              return
            const ref = withWorkspace(
              await provider.peek(file).catch(() => null)
            )
            this.byPath.set(file.path, {
              bytes: file.bytes,
              mtimeMs: file.mtimeMs,
              ref,
            })
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
    return this.list()
  }

  /** The known sessions, newest first, optionally narrowed to a workspace. */
  list(filter: { cwd?: string; harness?: string } = {}): ThreadRef[] {
    const refs: ThreadRef[] = []
    const admit = (ref: ThreadRef | null) => {
      if (!ref) return
      if (filter.harness && ref.harness !== filter.harness) return
      if (filter.cwd && ref.cwd !== filter.cwd) return
      refs.push(withWorkspace(ref) ?? ref)
    }
    for (const entry of this.byPath.values()) admit(entry.ref)
    // Sessions whose native store forgot them. The archive did not.
    if (this.archive) {
      const live = new Set(this.byPath.keys())
      for (const ref of this.archive.orphans(live)) admit(ref)
    }
    // One session, one row — whatever the path. Symlinked roots and the
    // archive can each present the same conversation twice; identity is the
    // harness's own session id. Live beats archived; newest beats older.
    const byIdentity = new Map<string, ThreadRef>()
    for (const ref of refs) {
      const key = `${ref.harness}:${ref.nativeId}`
      const held = byIdentity.get(key)
      if (
        !held ||
        (held.archived && !ref.archived) ||
        (held.archived === ref.archived &&
          (ref.updatedAt ?? "") > (held.updatedAt ?? ""))
      ) {
        byIdentity.set(key, ref)
      }
    }
    return [...byIdentity.values()].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
    )
  }

  /** Full translation of one session, via whichever store owns its path. */
  async open(path: string, trackForFollow = true): Promise<Thread | null> {
    const stamp = this.byPath.get(path)
    const held = this.threadCache
    const cached =
      held &&
      stamp &&
      held.path === path &&
      held.bytes === stamp.bytes &&
      held.mtimeMs === stamp.mtimeMs
        ? held.thread
        : null
    const provider = this.ownerOf(path)
    const native =
      cached ??
      withThreadWorkspace(
        provider ? await provider.read(path).catch(() => null) : null
      )
    if (native) {
      if (stamp && !cached) {
        this.threadCache = {
          path,
          bytes: stamp.bytes,
          mtimeMs: stamp.mtimeMs,
          thread: native,
        }
      }
      if (trackForFollow) {
        this.opened = {
          path,
          throughByte: native.ref.bytes ?? 0,
          entryCount: native.entries.length,
        }
      }
      return native
    }
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
    let unwatchable = false
    for (const provider of this.providers) {
      for (const root of provider.roots()) {
        if (!existsSync(root)) continue // Not installed: nothing to watch.
        try {
          const watcher = watch(
            root,
            { recursive: true },
            (_event, filename) => {
              if (!filename) return
              this.noticed(`${root}/${filename.toString()}`)
            }
          )
          watcher.on("error", () => this.ensurePolling())
          this.watchers.push(watcher)
        } catch {
          // Recursive watching is unavailable on some platforms and network
          // volumes. Those roots fall back to the polling rescan below.
          unwatchable = true
        }
      }
    }
    if (unwatchable) this.ensurePolling()
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
    onEntries: (
      entries: ThreadEntry[],
      replaced: boolean,
      replaceFrom?: number
    ) => void
  ): () => void {
    const provider = this.ownerOf(path)
    const opened =
      this.opened?.path === path && this.opened.throughByte === fromByte
        ? this.opened
        : null
    const state = this.follows.get(path) ?? {
      listeners: new Set(),
      follower: provider ? this.makeFollower(provider, path, fromByte) : null,
      fromByte,
      baselineCount: opened?.entryCount ?? null,
    }
    if (opened) this.opened = null
    state.listeners.add(onEntries)
    this.follows.set(path, state)
    return () => {
      state.listeners.delete(onEntries)
      if (state.listeners.size === 0) this.follows.delete(path)
    }
  }

  stop(): void {
    this.archive?.stop()
    for (const provider of this.providers) provider.close?.()
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.threadCache = null
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      void this.saveCache()
    }
  }

  /* ------------------------------------------------------------ internals */

  private ensurePolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.scan({ emitChanges: true })
    }, POLL_FALLBACK_MS)
    this.pollTimer.unref?.()
  }

  private ownerOf(path: string): SessionProvider | null {
    for (const provider of this.providers) {
      if (
        provider
          .roots()
          .some((root) => path.startsWith(`${root}/`) || path === root)
      ) {
        return provider
      }
    }
    return null
  }

  private noticed(path: string): void {
    const provider = this.ownerOf(path)
    if (!provider) return
    if (provider.rescanRoot || this.threadCache?.path === path) {
      this.threadCache = null
    }
    // Shared-database stores have no per-session file to stat: any write
    // under the root re-runs that provider's discovery, debounced under
    // one key so a burst costs one rescan.
    const key = provider.rescanRoot
      ? `rescan:${provider.harness}:${provider.roots()[0]}`
      : path
    clearTimeout(this.pending.get(key))
    this.pending.set(
      key,
      setTimeout(
        () => {
          this.pending.delete(key)
          if (provider.rescanRoot) void this.rescanProvider(provider)
          else void this.refresh(provider, path)
        },
        provider.rescanDebounceMs ?? WATCH_DEBOUNCE_MS
      )
    )
  }

  private rescanProvider(provider: SessionProvider): Promise<void> {
    const key = provider.harness
    const active = this.rescans.get(key)
    if (active) {
      active.requested = true
      return active.promise
    }
    const state: RefreshState = { requested: false, promise: Promise.resolve() }
    state.promise = (async () => {
      try {
        do {
          state.requested = false
          await this.rescanProviderOnce(provider)
          if (state.requested) {
            await new Promise((resolve) =>
              setTimeout(resolve, provider.rescanDebounceMs ?? WATCH_DEBOUNCE_MS)
            )
          }
        } while (state.requested)
      } finally {
        if (this.rescans.get(key) === state) this.rescans.delete(key)
      }
    })()
    this.rescans.set(key, state)
    return state.promise
  }

  /** Re-discover one provider's synthetic files; diff against the cache. */
  private async rescanProviderOnce(provider: SessionProvider): Promise<void> {
    const files = await provider.discover().catch((): NativeFile[] => [])
    const seen = new Set<string>()
    for (const file of files) {
      seen.add(file.path)
      const cached = this.byPath.get(file.path)
      const followed = (this.follows.get(file.path)?.listeners.size ?? 0) > 0
      if (
        !followed &&
        cached &&
        cached.bytes === file.bytes &&
        cached.mtimeMs === file.mtimeMs
      )
        continue
      const ref = withWorkspace(await provider.peek(file).catch(() => null))
      this.byPath.set(file.path, {
        bytes: file.bytes,
        mtimeMs: file.mtimeMs,
        ref,
      })
      if (ref) this.emit({ type: cached?.ref ? "updated" : "added", ref })
      const follow = this.follows.get(file.path)
      if (follow && follow.listeners.size > 0) {
        if (!follow.follower) {
          follow.follower = this.makeFollower(
            provider,
            file.path,
            follow.fromByte
          )
        }
        if (follow.follower) {
          const update = await follow.follower.next().catch(() => null)
          if (update && (update.replace || update.entries.length > 0)) {
            await this.deliverFollowerUpdate(
              provider,
              file.path,
              follow,
              update
            )
          }
        } else {
          const thread = await provider.read(file.path).catch(() => null)
          if (thread) {
            this.deliver(follow, {
              entries: thread.entries,
              nextByte: file.bytes,
              replace: true,
              replaceFrom: 0,
            })
          }
        }
      }
    }
    const prefix = provider.roots()[0] ?? ""
    for (const path of this.byPath.keys()) {
      if (path.startsWith(prefix) && !seen.has(path)) {
        this.byPath.delete(path)
        this.emit({ type: "removed", path })
      }
    }
    this.scheduleSave()
  }

  private refresh(provider: SessionProvider, path: string): Promise<void> {
    const active = this.refreshes.get(path)
    if (active) {
      active.requested = true
      return active.promise
    }
    const state: RefreshState = { requested: false, promise: Promise.resolve() }
    state.promise = (async () => {
      try {
        do {
          state.requested = false
          await this.refreshOnce(provider, path)
        } while (state.requested)
      } finally {
        if (this.refreshes.get(path) === state) this.refreshes.delete(path)
      }
    })()
    this.refreshes.set(path, state)
    return state.promise
  }

  private async refreshOnce(
    provider: SessionProvider,
    path: string
  ): Promise<void> {
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
    const follow = this.follows.get(path)
    const unchanged =
      cached && cached.bytes === file.bytes && cached.mtimeMs === file.mtimeMs
    if (
      unchanged &&
      (!follow?.follower || follow.follower.offset >= file.bytes)
    )
      return

    const grew = cached && file.bytes > cached.bytes
    const ref =
      grew && cached.ref
        ? {
            ...cached.ref,
            bytes: file.bytes,
            updatedAt: new Date(file.mtimeMs).toISOString(),
          }
        : withWorkspace(await provider.peek(file).catch(() => null))
    this.byPath.set(path, { bytes: file.bytes, mtimeMs: file.mtimeMs, ref })
    this.scheduleSave()
    if (ref) this.emit({ type: cached?.ref ? "updated" : "added", ref })

    if (!follow || follow.listeners.size === 0) return
    if (!follow.follower)
      follow.follower = this.makeFollower(provider, path, follow.fromByte)
    if (follow.follower) {
      if (!provider.createFollower && file.bytes < follow.follower.offset) {
        const thread = await provider.read(path).catch(() => null)
        follow.follower = this.makeFollower(provider, path, file.bytes)
        if (thread) {
          follow.baselineCount = thread.entries.length
          this.deliver(follow, {
            entries: thread.entries,
            nextByte: file.bytes,
            replace: true,
          })
        }
        return
      }
      const update = await follow.follower.next().catch(() => null)
      if (update?.reset && grew && cached.ref) {
        const resetRef = withWorkspace(
          await provider.peek(file).catch(() => null)
        )
        this.byPath.set(path, {
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
          ref: resetRef,
        })
        if (resetRef) this.emit({ type: "updated", ref: resetRef })
      }
      if (update && (update.replace || update.entries.length > 0)) {
        await this.deliverFollowerUpdate(provider, path, follow, update)
      }
      return
    }

    const thread = await provider.read(path).catch(() => null)
    if (thread)
      this.deliver(follow, {
        entries: thread.entries,
        nextByte: file.bytes,
        replace: true,
      })
  }

  private async deliverFollowerUpdate(
    provider: SessionProvider,
    path: string,
    follow: FollowState,
    update: SessionUpdate
  ): Promise<void> {
    if (update.reset) {
      follow.baselineCount = 0
      this.deliver(follow, update)
      return
    }
    if (update.replace && follow.baselineCount !== null) {
      this.deliver(follow, {
        ...update,
        replaceFrom: Math.max(
          0,
          follow.baselineCount + (update.replaceFrom ?? 0)
        ),
      })
      return
    }
    if (update.replace) {
      const thread = await provider.read(path).catch(() => null)
      if (thread) {
        this.deliver(follow, {
          ...update,
          entries: thread.entries,
          replaceFrom: 0,
        })
      }
      return
    }
    this.deliver(follow, update)
  }

  private makeFollower(
    provider: SessionProvider,
    path: string,
    fromByte: number
  ): SessionFollower | null {
    if (provider.createFollower) return provider.createFollower(path, fromByte)
    if (!provider.tail) return null
    let offset = fromByte
    return {
      get offset() {
        return offset
      },
      async next() {
        const result = await provider.tail!(path, offset)
        offset = Math.max(offset, result.nextByte)
        return { entries: result.entries, nextByte: offset, replace: false }
      },
    }
  }

  private deliver(follow: FollowState, update: SessionUpdate): void {
    for (const listener of follow.listeners)
      listener(update.entries, update.replace, update.replaceFrom)
  }

  private emit(event: CatalogEvent): void {
    // Every added or grown session is also recorded in the archive — the
    // copy that survives the native store. Lazy read, throttled inside.
    if (this.archive && (event.type === "added" || event.type === "updated")) {
      const ref = event.ref
      if (!ref.archived)
        this.archive.note(ref, () => this.open(ref.path, false))
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
      const entries = parseCache(raw)
      if (entries) this.byPath = entries
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
      await writeFile(
        this.cachePath,
        JSON.stringify({ version: 1, entries }),
        "utf8"
      )
    } catch {
      // A failed cache write costs the next start a re-peek, nothing more.
    }
  }
}

function parseCache(raw: string): Map<string, CacheEntry> | null {
  try {
    const value: JsonValue = JSON.parse(raw)
    if (!isJsonRecord(value) || readNumber(value, "version") !== 1) return null
    const stored = value.entries
    if (!isJsonRecord(stored)) return null
    const entries = new Map<string, CacheEntry>()
    for (const [path, candidate] of Object.entries(stored)) {
      const entry = parseCacheEntry(candidate)
      if (!entry) return null
      entries.set(path, entry)
    }
    return entries
  } catch {
    return null
  }
}

function parseCacheEntry(value: JsonValue | undefined): CacheEntry | null {
  if (!isJsonRecord(value)) return null
  const bytes = readNumber(value, "bytes")
  const mtimeMs = readNumber(value, "mtimeMs")
  if (bytes === undefined || mtimeMs === undefined) return null
  if (value.ref === null) return { bytes, mtimeMs, ref: null }
  const ref = parseCachedThreadRef(value.ref)
  return ref ? { bytes, mtimeMs, ref } : null
}

function parseCachedThreadRef(value: JsonValue | undefined): ThreadRef | null {
  if (!isJsonRecord(value)) return null
  const harness = readString(value, "harness")
  const nativeId = readString(value, "nativeId")
  const path = readString(value, "path")
  if (!harness || !nativeId || !path) return null
  const ref: ThreadRef = { harness, nativeId, path }
  const cwd = readString(value, "cwd")
  const title = readString(value, "title")
  const model = readString(value, "model")
  const startedAt = readString(value, "startedAt")
  const updatedAt = readString(value, "updatedAt")
  const bytes = readNumber(value, "bytes")
  const locked = readBoolean(value, "locked")
  const lineage = parseArray(value.lineage, parseThreadOrigin)
  const modelProvider = readString(value, "modelProvider")
  const archived = readBoolean(value, "archived")
  if (cwd !== undefined) ref.cwd = cwd
  if (title !== undefined) ref.title = title
  if (model !== undefined) ref.model = model
  if (startedAt !== undefined) ref.startedAt = startedAt
  if (updatedAt !== undefined) ref.updatedAt = updatedAt
  if (bytes !== undefined) ref.bytes = bytes
  if (locked !== undefined) ref.locked = locked
  if (lineage) ref.lineage = lineage
  if (modelProvider !== undefined) ref.modelProvider = modelProvider
  if (archived !== undefined) ref.archived = archived
  return ref
}

function parseThreadOrigin(value: JsonValue): ThreadOrigin | null {
  if (!isJsonRecord(value)) return null
  const harness = readString(value, "harness")
  if (!harness) return null
  const origin: ThreadOrigin = { harness }
  const title = readString(value, "title")
  if (title !== undefined) origin.title = title
  return origin
}

function parseArray<T>(
  value: JsonValue | undefined,
  parse: (item: JsonValue) => T | null
): T[] | null {
  if (!Array.isArray(value)) return null
  const parsed: T[] = []
  for (const item of value) {
    const result = parse(item)
    if (result === null) return null
    parsed.push(result)
  }
  return parsed
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function isStringValue(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumberValue(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

function isBooleanValue(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return isStringValue(value) ? value : undefined
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return isNumberValue(value) && Number.isFinite(value) ? value : undefined
}

function readBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key]
  return isBooleanValue(value) ? value : undefined
}
