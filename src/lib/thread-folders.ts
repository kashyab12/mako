import { workspaceName } from "@/lib/format"
import type { ThreadRef } from "@/lib/types"
import type { RailSortBy } from "@/state/prefs"

export interface ThreadFolderActivity {
  running?: boolean
  needsInput?: boolean
  failed?: boolean
  unread?: boolean
  active?: boolean
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
  ref: ThreadRef,
  workspace: string | undefined
): boolean {
  const root = normalizedPath(workspace)
  if (!root) return true
  return [ref.cwd, ref.workspace].some((candidate) => {
    const path = normalizedPath(candidate)
    return path === root || path.startsWith(`${root}/`)
  })
}

export function threadFolderKey(ref: ThreadRef): string {
  return folderPath(ref.workspace ?? ref.cwd)
}

export function groupThreadFolders({
  refs,
  currentCwd,
  pinnedThreads,
  pinnedFolders,
  priorities = {},
  activity = {},
  sortBy,
}: {
  refs: ThreadRef[]
  currentCwd?: string
  pinnedThreads: string[]
  pinnedFolders: string[]
  priorities?: Record<string, number>
  activity?: Record<string, ThreadFolderActivity>
  sortBy: RailSortBy
}): ThreadFolder[] {
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
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  }
  const normalizedPinnedFolders = pinnedFolders.map(folderPath)
  const pinned = new Set(normalizedPinnedFolders)
  const result: ThreadFolder[] = [...byCwd.entries()].map(([key, entries]) => {
    entries.sort(byOrder)
    const allEntries = allByCwd.get(key) ?? entries
    const latest = allEntries.reduce(
      (top, ref) => ((ref.updatedAt ?? "") > top ? ref.updatedAt! : top),
      ""
    )
    const order =
      sortBy === "created"
        ? allEntries.reduce(
            (top, ref) =>
              (ref.startedAt ?? "") > top ? ref.startedAt! : top,
            ""
          )
        : latest
    let priority = 0
    let running = 0
    let needsInput = 0
    let failed = 0
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
    if (a.current !== b.current) return a.current ? -1 : 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return pinIndex(a) - pinIndex(b)
    if (a.priority !== b.priority) return b.priority - a.priority
    if (sortBy === "name") return a.name.localeCompare(b.name)
    return b.order.localeCompare(a.order)
  })
  return result
}
