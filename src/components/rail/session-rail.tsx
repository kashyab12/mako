import { useCallback, useDeferredValue, useMemo, useState } from "react"
import { Action, Blank, IconAction } from "@/components/ui/kit"
import { VirtualSessions } from "@/components/rail/virtual-sessions"
import { buildRows } from "@/components/rail/rail-rows"
import { RailOptions } from "@/components/rail/rail-options"
import { Slot } from "@/extend/slot"
import { formatChord } from "@/extend/commands"
import { actions, useSession } from "@/state/session"
import { workspaceName } from "@/lib/format"
import { setPref, usePrefs } from "@/state/prefs"
import { FolderIcon, MessagesSquareIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react"

/** Varied widths, because real session titles are not all the same length. */
const SKELETON_ROWS = [
  { title: "62%", meta: "38%" },
  { title: "48%", meta: "30%" },
  { title: "70%", meta: "44%" },
  { title: "40%", meta: "26%" },
  { title: "56%", meta: "34%" },
]

/**
 * The session rail.
 *
 * Two axes, both the user's to set: scope (this project, or everywhere Pi has
 * run) and grouping (by recency, or by project). Together they turn the rail
 * from a list of one folder's chats into the way you move between projects.
 *
 * Virtualized because a long-lived install accumulates hundreds of sessions
 * and this list is on screen the whole time — paying full layout for rows
 * nobody can see is the cost the window can least afford while tokens stream
 * next door.
 */
export function SessionRail() {
  const [query, setQuery] = useState("")
  // Typing stays responsive on large session sets; the list catches up.
  const deferred = useDeferredValue(query)

  const sessions = useSession((state) => state.sessions)
  const loading = useSession((state) => state.sessionsLoading)
  const cwd = useSession((state) => state.meta?.cwd)
  const activePath = useSession((state) => state.meta?.sessionFile)

  const scope = usePrefs((prefs) => prefs.railScope)
  const groupBy = usePrefs((prefs) => prefs.railGroupBy)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const collapsed = usePrefs((prefs) => prefs.collapsedGroups)

  const rows = useMemo(
    () => buildRows({ sessions, query: deferred, groupBy, sortBy, collapsed, activeCwd: cwd }),
    [collapsed, cwd, deferred, groupBy, sortBy, sessions]
  )

  const open = useCallback((path: string) => void actions.openSession(path), [])
  const showProject = scope === "all" && groupBy !== "project"

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <button
          type="button"
          onClick={() => void actions.pickWorkspace()}
          title={`${cwd}\nClick to open a different folder`}
          className="pressable flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-raised"
        >
          <FolderIcon className="size-3.5 shrink-0 text-faint" />
          <span className="truncate text-[12.5px] font-semibold">{workspaceName(cwd)}</span>
        </button>
        <Slot name="rail.header" />
        <IconAction
          label="New session"
          keys={formatChord("mod+n")}
          onClick={() => void actions.newSession()}
        >
          <PlusIcon />
        </IconAction>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 py-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("")
            }}
            placeholder={scope === "all" ? "Search every project" : "Search this project"}
            className="h-7 w-full rounded-md bg-raised pr-7 pl-7 text-[12.5px] placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        <RailOptions />
      </div>

      {loading && sessions.length === 0 ? (
        <div className="px-2.5 pt-1">
          {SKELETON_ROWS.map((row, index) => (
            <div
              key={index}
              className="flex h-[42px] flex-col justify-center gap-1.5"
              // Staggered so the list reads as filling in rather than as one
              // block flashing.
              style={{ opacity: 1 - index * 0.16 }}
            >
              <div className="flex items-center gap-2">
                <span className="skeleton h-2.5" style={{ width: row.title }} />
                <span className="skeleton ml-auto h-2 w-6" />
              </div>
              <span className="skeleton h-2" style={{ width: row.meta }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Blank
          icon={<MessagesSquareIcon />}
          title={query ? "No matches" : "No sessions here"}
          body={
            query
              ? scope === "workspace"
                ? "Nothing in this project matches. Try searching every project."
                : "Try a different term."
              : "Start one in this folder — Pi keeps the history, the desk just makes it visible."
          }
          action={
            query ? (
              scope === "workspace" ? (
                <Action
                  tone="outline"
                  className="mt-2"
                  onClick={() => {
                    setPref("railScope", "all")
                    void actions.refreshSessions(undefined, "all")
                  }}
                >
                  Search every project
                </Action>
              ) : null
            ) : (
              <Action tone="outline" className="mt-2" onClick={() => void actions.newSession()}>
                New session
              </Action>
            )
          }
        />
      ) : (
        <VirtualSessions
          rows={rows}
          activePath={activePath}
          showProject={showProject}
          onOpen={open}
        />
      )}

      <Slot name="rail.footer" />
    </aside>
  )
}

