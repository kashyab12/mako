import type { SessionSummary } from "@/lib/types"
import { bucketFor, workspaceName } from "@/lib/format"
import { rank } from "@/lib/fuzzy"
import type { RailGroupBy, RailSortBy } from "@/state/prefs"

/**
 * The rail's row model, flattened.
 *
 * A flat `header | session` list is what makes the rail both virtualizable and
 * regroupable: switching between "recent" and "project" changes which headers
 * get emitted and nothing else. The shape is borrowed from ORCA's sidebar,
 * which flattens groups the same way for the same two reasons.
 */
export type RailRow =
  | {
      kind: "header"
      key: string
      label: string
      count: number
      /** Absent for time buckets, present for project groups. */
      cwd?: string
      collapsed: boolean
    }
  | { kind: "session"; key: string; session: SessionSummary }

const TIME_ORDER = ["Today", "Yesterday", "This week", "This month", "Earlier"]

export function buildRows({
  sessions,
  query,
  groupBy,
  sortBy,
  collapsed,
  activeCwd,
  pinned = [],
}: {
  sessions: SessionSummary[]
  query: string
  groupBy: RailGroupBy
  sortBy: RailSortBy
  collapsed: string[]
  activeCwd?: string
  pinned?: string[]
}): RailRow[] {
  const ordered = sortSessions(sessions, sortBy)
  const matched = rank(ordered, query, (session) =>
    // Searching should reach the project name too, so "flage" finds a session
    // in that repo without first switching scope to it.
    `${session.name ?? ""} ${session.firstMessage} ${workspaceName(session.cwd)}`
  )

  // Pinned rows lead, in the order they were pinned, and leave the groups
  // below them — a pinned session in "This week" too would be a duplicate,
  // not an emphasis. While searching, pins rank like everything else.
  let pinnedRows: RailRow[] = []
  let rest = matched
  if (!query.trim() && pinned.length > 0) {
    const set = new Set(pinned)
    const held = matched.filter((session) => set.has(session.path))
    if (held.length > 0) {
      held.sort((a, b) => pinned.indexOf(a.path) - pinned.indexOf(b.path))
      pinnedRows = [
        { kind: "header", key: "pinned", label: "Pinned", count: held.length, collapsed: false },
        ...held.map((session) => ({ kind: "session" as const, key: session.path, session })),
      ]
      rest = matched.filter((session) => !set.has(session.path))
    }
  }

  if (query.trim()) {
    return [
      {
        kind: "header",
        key: "results",
        label: matched.length === 1 ? "1 match" : `${matched.length} matches`,
        count: matched.length,
        collapsed: false,
      },
      ...matched.map((session) => ({
        kind: "session" as const,
        key: session.path,
        session,
      })),
    ]
  }

  const isCollapsed = (key: string) => collapsed.includes(key)
  const rows: RailRow[] = [...pinnedRows]

  if (groupBy === "none") {
    return [
      ...pinnedRows,
      ...rest.map((session) => ({
        kind: "session" as const,
        key: session.path,
        session,
      })),
    ]
  }

  if (groupBy === "project") {
    const groups = new Map<string, SessionSummary[]>()
    for (const session of rest) {
      const list = groups.get(session.cwd)
      if (list) list.push(session)
      else groups.set(session.cwd, [session])
    }

    // The project you are in sorts first; the rest by most recent activity.
    const ordered = [...groups.entries()].sort(([a], [b]) => {
      if (a === activeCwd) return -1
      if (b === activeCwd) return 1
      const at = groups.get(a)?.[0]?.modified ?? ""
      const bt = groups.get(b)?.[0]?.modified ?? ""
      return bt.localeCompare(at)
    })

    for (const [cwd, group] of ordered) {
      const key = `project:${cwd}`
      const down = isCollapsed(key)
      rows.push({
        kind: "header",
        key,
        label: workspaceName(cwd),
        count: group.length,
        cwd,
        collapsed: down,
      })
      if (down) continue
      for (const session of group) {
        rows.push({ kind: "session", key: session.path, session })
      }
    }
    return rows
  }

  const buckets = new Map<string, SessionSummary[]>()
  for (const session of rest) {
    const label = bucketFor(session.modified)
    const list = buckets.get(label)
    if (list) list.push(session)
    else buckets.set(label, [session])
  }

  for (const label of TIME_ORDER) {
    const group = buckets.get(label)
    if (!group) continue
    const key = `time:${label}`
    const down = isCollapsed(key)
    rows.push({ kind: "header", key, label, count: group.length, collapsed: down })
    if (down) continue
    for (const session of group) {
      rows.push({ kind: "session", key: session.path, session })
    }
  }
  return rows
}

/**
 * Search already ranks by relevance, so ordering only applies to the unfiltered
 * list. Recency is the default because a session you touched a minute ago is
 * almost always the one you want.
 */
function sortSessions(sessions: SessionSummary[], sortBy: RailSortBy): SessionSummary[] {
  const copy = [...sessions]
  switch (sortBy) {
    case "name":
      return copy.sort((a, b) =>
        (a.name || a.firstMessage).localeCompare(b.name || b.firstMessage)
      )
    case "size":
      return copy.sort((a, b) => b.messageCount - a.messageCount)
    default:
      return copy.sort((a, b) => b.modified.localeCompare(a.modified))
  }
}
