import { workspaceName } from "@/lib/format"
import type { ThreadRef } from "@/lib/types"
import type { RailSortBy } from "@/state/prefs"

export interface ThreadFolder {
  key: string
  name: string
  cwd: string | null
  refs: ThreadRef[]
  current: boolean
  pinned: boolean
  latest: string
  order: string
}

export function threadFolderKey(ref: ThreadRef): string {
  const path = (ref.workspace ?? ref.cwd ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
  if (!path) return ""
  if (/^\/(?:Users|home)\/[^/]+$/.test(path)) return ""
  if (/^\/(?:private\/)?tmp(?:\/|$)/.test(path)) return ""
  if (/^\/(?:private\/)?var\/folders(?:\/|$)/.test(path)) return ""
  if (/^[A-Za-z]:\/Users\/[^/]+$/.test(path)) return ""
  if (/^[A-Za-z]:\/Users\/[^/]+\/AppData\/Local\/Temp(?:\/|$)/i.test(path)) return ""
  return path
}

export function groupThreadFolders({
  refs,
  currentCwd,
  pinnedThreads,
  pinnedFolders,
  sortBy,
}: {
  refs: ThreadRef[]
  currentCwd?: string
  pinnedThreads: string[]
  pinnedFolders: string[]
  sortBy: RailSortBy
}): ThreadFolder[] {
  const held = new Set(pinnedThreads)
  const byCwd = new Map<string, ThreadRef[]>()
  for (const ref of refs) {
    if (held.has(ref.path)) continue
    const key = threadFolderKey(ref)
    const list = byCwd.get(key)
    if (list) list.push(ref)
    else byCwd.set(key, [ref])
  }
  const byOrder = (a: ThreadRef, b: ThreadRef): number => {
    if (sortBy === "name") return (a.title ?? "").localeCompare(b.title ?? "")
    if (sortBy === "created")
      return (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  }
  const pinned = new Set(pinnedFolders)
  const result: ThreadFolder[] = [...byCwd.entries()].map(([key, entries]) => {
    entries.sort(byOrder)
    const latest = entries.reduce(
      (top, ref) => ((ref.updatedAt ?? "") > top ? ref.updatedAt! : top),
      ""
    )
    const order =
      sortBy === "created"
        ? entries.reduce(
            (top, ref) =>
              (ref.startedAt ?? "") > top ? ref.startedAt! : top,
            ""
          )
        : latest
    return {
      key: key || "~",
      name: key ? workspaceName(key) : "Other sessions",
      cwd: key || null,
      refs: entries,
      current:
        Boolean(currentCwd) &&
        entries.some(
          (ref) => ref.cwd === currentCwd || ref.workspace === currentCwd
        ),
      pinned:
        Boolean(key) &&
        (pinned.has(key) ||
          entries.some((ref) => Boolean(ref.cwd && pinned.has(ref.cwd)))),
      latest,
      order,
    }
  })
  const pinIndex = (folder: ThreadFolder) => {
    const direct = folder.cwd ? pinnedFolders.indexOf(folder.cwd) : -1
    if (direct >= 0) return direct
    return pinnedFolders.findIndex((path) =>
      folder.refs.some((ref) => ref.cwd === path)
    )
  }
  result.sort((a, b) => {
    if (a.cwd === null || b.cwd === null) return a.cwd === null ? 1 : -1
    if (a.current !== b.current) return a.current ? -1 : 1
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return pinIndex(a) - pinIndex(b)
    if (sortBy === "name") return a.name.localeCompare(b.name)
    return b.order.localeCompare(a.order)
  })
  return result
}
