import { workspaceName } from "@/lib/format"
import type { ThreadRef } from "@/lib/types"
import type { RailSortBy } from "@/state/prefs"
import type { AcpPresence } from "@/state/acp-presence"

export interface ThreadFolderActivity {
  running?: boolean
  needsInput?: boolean
  failed?: boolean
  unread?: boolean
  active?: boolean
  /** Its file changed within the last minute; the writer may be outside Mako. */
  observed?: boolean
}

export interface ThreadFolder {
  key: string
  name: string
  cwd: string | null
  refs: ThreadRef[]
  current: boolean
  pinned: boolean
  latest: string
  order: string
  priority: number
  running: number
  needsInput: number
  failed: number
  unread: number
  active: number
}

/**
 * Keep the normal project order stable while ensuring a project selected by
 * another surface is not hidden behind pagination. A project already in the
 * first page stays exactly where it was; an off-page current project is added
 * at its natural relative position.
 */
export function visibleThreadFolders(
  folders: ThreadFolder[],
  limit: number
): ThreadFolder[] {
  const visible = new Set(folders.slice(0, limit).map((folder) => folder.key))
  const current = folders.find((folder) => folder.current)
  if (current) visible.add(current.key)
  return folders.filter((folder) => visible.has(folder.key))
}

function normalizedPath(path: string | undefined): string {
  const normalized = (path ?? "").replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function folderPath(path: string | undefined): string {
  const normalized = normalizedPath(path)
  if (!normalized) return ""
  if (/^\/(?:private\/)?tmp(?:\/|$)/.test(normalized)) return ""
  if (/^\/(?:private\/)?var\/folders(?:\/|$)/.test(normalized)) return ""
  if (/^[a-z]:\/users\/[^/]+\/appdata\/local\/temp(?:\/|$)/.test(normalized)) return ""
  return normalized
}

function isHomePath(path: string): boolean {
  return (
    /^\/(?:Users|home)\/[^/]+$/.test(path) ||
    /^[a-z]:\/users\/[^/]+$/.test(path)
  )
}

export function threadBelongsToWorkspace(
  ref: Pick<ThreadRef, "cwd" | "workspace">,
  workspace: string | undefined
): boolean {
  const root = normalizedPath(workspace)
  if (!root) return true
  return [ref.cwd, ref.workspace].some((candidate) => {
    const path = normalizedPath(candidate)
    return path === root || path.startsWith(`${root}/`)
  })
}

export function threadFolderKey(ref: Pick<ThreadRef, "cwd" | "workspace">): string {
  return folderPath(ref.workspace ?? ref.cwd)
}

/** Where a thread sits in "latest activity" order, and why it sits there. */
export interface RailRank {
  at: string
  active: boolean
}

/** Held ranks by thread path. */
export interface RailRanks {
  [path: string]: RailRank
}

/**
 * Recency that holds still while work happens.
 *
 * A working thread's file changes many times a second, and every change
 * moved its updatedAt and with it the row, the folder, and everything below.
 * Two agents in two projects swapped places on every token. So a thread
 * takes a rank when it is first seen, moves once when it becomes active,
 * keeps that rank for as long as it stays active, and settles once when it
 * finishes. An idle thread still follows its file: activity from outside
 * Mako is real news.
 */
export function stableThreadRanks(
  refs: readonly ThreadRef[],
  activity: Record<string, ThreadFolderActivity>,
  previous: RailRanks
): RailRanks {
  const next: RailRanks = {}
  for (const ref of refs) {
    const state = activity[ref.path]
    const active = Boolean(
      state?.running || state?.needsInput || state?.active || state?.observed
    )
    const held = previous[ref.path]
    const at = ref.updatedAt ?? ""
    if (held && active && held.active) next[ref.path] = held
    else if (held && active) next[ref.path] = { at: at > held.at ? at : held.at, active }
    else next[ref.path] = { at, active }
  }
  return next
}

export function groupThreadFolders({
  refs,
  live = [],
  currentCwd,
  pinnedThreads,
  pinnedFolders,
  priorities = {},
  activity = {},
  ranks = {},
  sortBy,
}: {
  refs: ThreadRef[]
  live?: AcpPresence[]
  currentCwd?: string
  pinnedThreads: string[]
  pinnedFolders: string[]
  priorities?: Record<string, number>
  activity?: Record<string, ThreadFolderActivity>
  /** Held recency from `stableThreadRanks`; a thread without one uses its updatedAt. */
  ranks?: RailRanks
  sortBy: RailSortBy
}): ThreadFolder[] {
  const recency = (ref: ThreadRef): string => ranks[ref.path]?.at ?? ref.updatedAt ?? ""
  const held = new Set(pinnedThreads)
  const byCwd = new Map<string, ThreadRef[]>()
  const allByCwd = new Map<string, ThreadRef[]>()
  for (const ref of refs) {
    const key = threadFolderKey(ref)
    const all = allByCwd.get(key)
    if (all) all.push(ref)
    else allByCwd.set(key, [ref])
    if (!byCwd.has(key)) byCwd.set(key, [])
    if (held.has(ref.path)) continue
    byCwd.get(key)?.push(ref)
  }
  for (const presence of live) {
    const key = threadFolderKey(presence)
    if (!byCwd.has(key)) byCwd.set(key, [])
  }
  const normalizedCurrent = folderPath(currentCwd)
  const currentKey =
    [...byCwd.keys()]
      .filter(
        (key) =>
          key &&
          (key === normalizedCurrent || normalizedCurrent.startsWith(`${key}/`))
      )
      .sort((left, right) => right.length - left.length)[0] ?? normalizedCurrent
  if (currentKey && !byCwd.has(currentKey)) byCwd.set(currentKey, [])
  const byOrder = (a: ThreadRef, b: ThreadRef): number => {
    const urgency = (priorities[b.path] ?? 0) - (priorities[a.path] ?? 0)
    if (urgency !== 0) return urgency
    if (sortBy === "name") return (a.title ?? "").localeCompare(b.title ?? "")
    if (sortBy === "created")
      return (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
    return recency(b).localeCompare(recency(a))
  }
  const normalizedPinnedFolders = pinnedFolders.map(folderPath)
  const pinned = new Set(normalizedPinnedFolders)
  const result: ThreadFolder[] = [...byCwd.entries()].map(([key, entries]) => {
    entries.sort(byOrder)
    const allEntries = allByCwd.get(key) ?? entries
    const present = live.filter((presence) => threadFolderKey(presence) === key)
    const liveLatest = present.reduce((latest, presence) => Math.max(latest, presence.createdAt), 0)
    const latest = allEntries.reduce(
      (top, ref) => ((ref.updatedAt ?? "") > top ? ref.updatedAt! : top),
      liveLatest ? new Date(liveLatest).toISOString() : ""
    )
    const order =
      sortBy === "created"
        ? allEntries.reduce(
            (top, ref) =>
              (ref.startedAt ?? "") > top ? ref.startedAt! : top,
            ""
          )
        : allEntries.reduce(
            (top, ref) => (recency(ref) > top ? recency(ref) : top),
            liveLatest ? new Date(liveLatest).toISOString() : ""
          )
    let running = present.filter((presence) => presence.status === "running" || presence.status === "starting").length
    let needsInput = present.filter((presence) => presence.status === "needs-permission").length
    let failed = present.filter((presence) => presence.status === "failed").length
    let priority = needsInput ? 5 : failed ? 4 : running ? 2 : 0
    let unread = 0
    let active = 0
    for (const ref of allEntries) {
      priority = Math.max(priority, priorities[ref.path] ?? 0)
      const state = activity[ref.path]
      if (state?.running) running += 1
      if (state?.needsInput) needsInput += 1
      if (state?.failed) failed += 1
      if (state?.unread) unread += 1
      if (state?.active) active += 1
    }
    return {
      key: key || "~",
      name: key ? (isHomePath(key) ? "Home" : workspaceName(key)) : "Other sessions",
      cwd: key || null,
      refs: entries,
      current: Boolean(currentKey) && key === currentKey,
      pinned:
        Boolean(key) &&
        (pinned.has(key) ||
          allEntries.some((ref) =>
            [ref.cwd, ref.workspace].some(
              (path) => Boolean(path) && pinned.has(folderPath(path))
            )
          )),
      latest,
      order,
      priority,
      running,
      needsInput,
      failed,
      unread,
      active,
    }
  })
  const pinIndex = (folder: ThreadFolder) => {
    const direct = folder.cwd
      ? normalizedPinnedFolders.indexOf(folder.cwd)
      : -1
    if (direct >= 0) return direct
    const entries = allByCwd.get(folder.cwd ?? "") ?? folder.refs
    return normalizedPinnedFolders.findIndex((path) =>
      entries.some((ref) =>
        [ref.cwd, ref.workspace].some(
          (candidate) => folderPath(candidate) === path
        )
      )
    )
  }
  result.sort((a, b) => {
    if (a.cwd === null || b.cwd === null) return a.cwd === null ? 1 : -1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return pinIndex(a) - pinIndex(b)
    if (a.priority !== b.priority) return b.priority - a.priority
    if (sortBy === "name") return a.name.localeCompare(b.name)
    return b.order.localeCompare(a.order)
  })
  return result
}
