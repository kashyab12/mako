import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { harnessLabel } from "@/components/rail/harness-meta"
import { formatRelative, workspaceName } from "@/lib/format"
import { threadActivity, threads, useThreads } from "@/state/threads"
import { actions, shallowEqual, useSession } from "@/state/session"
import {
  prefsStore,
  setPref,
  togglePinned,
  togglePinnedProject,
  usePrefs,
} from "@/state/prefs"
import { cn } from "@/lib/utils"
import { useTabs, type TabInfo } from "@/state/tabs"
import { Blank } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  ArchiveIcon,
  FolderPlusIcon,
  ListFilterIcon,
  Loader2Icon,
  LockKeyholeIcon,
  MessagesSquareIcon,
  PinIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import type { ThreadRef } from "@/lib/types"

/**
 * The threads rail: every agent's conversations, arranged the way work is —
 * by folder, most alive first.
 *
 * The current workspace leads and shows its freshest threads; other folders
 * follow by recency, each holding a handful of rows and a quiet "More" for
 * the rest; folders gone cold collapse to a single line. No chips, no
 * toggles, no permanent search box — search and the harness filter live
 * behind two small glyphs in the header and take space only while in use.
 * A row is one line: the harness's mark, the title, and how long ago. The
 * marks carry the multi-harness story; everything else stays out of the way.
 */

/** Rows a folder shows before "More": generous for the folder being worked. */
const LEAD_ROWS = 5
const REST_ROWS = 3
/** Each press of "More" reveals this many further rows. */
const PAGE_ROWS = 5
const PINNED_ROWS = 8
const PROJECT_ROWS = 6
/** Folders quiet longer than this start out collapsed. */
const COLD_MS = 7 * 24 * 3600_000
const LIVE_TIME_MS = 60_000
const INITIAL_TIME = Date.now()

interface AgentActivity {
  harness: string
  count: number
}

interface Folder {
  key: string
  name: string
  cwd: string | null
  refs: ThreadRef[]
  current: boolean
  pinned: boolean
  latest: string
}

function useLiveTime(): number {
  const [now, setNow] = useState(INITIAL_TIME)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TIME_MS)
    return () => window.clearInterval(timer)
  }, [])

  return now
}

export function AgentThreads() {
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [showAllPinned, setShowAllPinned] = useState(false)
  const [showAllProjects, setShowAllProjects] = useState(false)
  // Extra pages unfolded per folder — More reveals a handful at a time,
  // not the whole archive in one avalanche.
  const [pages, setPages] = useState<Record<string, number>>({})
  const deferred = useDeferredValue(query)
  const all = useThreads((state) => state.threads)
  const loaded = useThreads((state) => state.loaded)
  const running = useThreads((state) => state.running)
  const observed = useThreads((state) => state.observed)
  const filter = usePrefs((prefs) => prefs.agentHarnessFilter)
  const pinned = usePrefs((prefs) => prefs.pinnedThreads)
  const pinnedProjects = usePrefs((prefs) => prefs.pinnedProjects)
  const collapsed = usePrefs((prefs) => prefs.collapsedGroups)
  const scope = usePrefs((prefs) => prefs.railScope)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const cwd = useSession((state) => state.meta?.cwd)
  const now = useLiveTime()

  const counts = useMemo(() => {
    const byHarness = new Map<string, number>()
    for (const ref of all) {
      byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
    }
    return byHarness
  }, [all])

  const activity = useMemo(() => {
    const byHarness = new Map<string, number>()
    for (const ref of all) {
      if (!running[ref.path] && !observed[ref.path]) continue
      byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
    }
    return [...byHarness.entries()].map(
      ([harness, count]): AgentActivity => ({ harness, count })
    )
  }, [all, observed, running])

  const matched = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    const active = filter.length > 0 ? new Set(filter) : null
    return all.filter(
      (ref) =>
        (scope !== "workspace" || !cwd || ref.cwd === cwd) &&
        (!active || active.has(ref.harness)) &&
        (!needle ||
          `${ref.title ?? ""} ${ref.cwd ?? ""} ${harnessLabel(ref.harness)} ${ref.model ?? ""}`
            .toLowerCase()
            .includes(needle))
    )
  }, [all, cwd, deferred, filter, scope])

  const held = useMemo(() => {
    const set = new Set(pinned)
    const list = matched.filter((ref) => set.has(ref.path))
    list.sort((a, b) => pinned.indexOf(a.path) - pinned.indexOf(b.path))
    return list
  }, [matched, pinned])

  const folders = useMemo<Folder[]>(() => {
    const set = new Set(pinned)
    const byCwd = new Map<string, ThreadRef[]>()
    for (const ref of matched) {
      if (set.has(ref.path)) continue
      const key = ref.cwd ?? ""
      const list = byCwd.get(key)
      if (list) list.push(ref)
      else byCwd.set(key, [ref])
    }
    const byOrder = (a: ThreadRef, b: ThreadRef): number => {
      if (sortBy === "name") return (a.title ?? "").localeCompare(b.title ?? "")
      if (sortBy === "created") return (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
    }
    const pinnedSet = new Set(pinnedProjects)
    const result: Folder[] = [...byCwd.entries()].map(([key, refs]) => {
      refs.sort(byOrder)
      return {
        key: key || "~",
        name: key ? workspaceName(key) : "Sessions",
        cwd: key || null,
        refs,
        current: Boolean(cwd) && key === cwd,
        pinned: Boolean(key) && pinnedSet.has(key),
        latest: refs.reduce((top, ref) => ((ref.updatedAt ?? "") > top ? ref.updatedAt! : top), ""),
      }
    })
    result.sort((a, b) => {
      if (a.cwd === null || b.cwd === null) return a.cwd === null ? 1 : -1
      if (a.current !== b.current) return a.current ? -1 : 1
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.pinned && b.pinned)
        return pinnedProjects.indexOf(a.cwd) - pinnedProjects.indexOf(b.cwd)
      if (sortBy === "name") return a.name.localeCompare(b.name)
      return b.latest.localeCompare(a.latest)
    })
    return result
  }, [cwd, matched, pinned, pinnedProjects, sortBy])

  const searchActive = Boolean(deferred.trim())
  const shownPinned = showAllPinned ? held : held.slice(0, PINNED_ROWS)
  const hiddenPinned = held.length - shownPinned.length
  const projects = folders.filter((folder) => folder.cwd !== null)
  const sessions = folders.find((folder) => folder.cwd === null)
  const priorityProjects = projects.filter(
    (folder) => folder.current || folder.pinned
  ).length
  const shownProjects = showAllProjects
    ? projects
    : projects.slice(0, Math.max(PROJECT_ROWS, priorityProjects))
  const hiddenProjects = projects.length - shownProjects.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RailHeader
        searching={searching}
        query={query}
        onQuery={setQuery}
        onToggleSearch={(next) => {
          setSearching(next)
          if (!next) setQuery("")
        }}
        counts={counts}
        filter={filter}
      />
      <ActiveAgents activity={activity} />

      <div className="scroll-fade-scope flex min-h-0 flex-1 flex-col">
      <span aria-hidden className="scroll-fade-top [--fade-from:var(--shell)]" />
      <div className="scroll-fade-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {!loaded && matched.length === 0 ? (
          <RailSkeleton />
        ) : matched.length === 0 ? (
          searchActive || filter.length > 0 ? (
            <p className="px-3 pt-8 text-center text-ui leading-relaxed text-faint">
              Nothing matches.
            </p>
          ) : (
            <Blank
              icon={<MessagesSquareIcon />}
              title="No conversations yet"
              body="Threads from every agent land here."
              hints={[
                {
                  label: "Ask for a change",
                  keys: formatChord("mod+l"),
                  onSelect: () => window.dispatchEvent(new CustomEvent("mako:focus-composer")),
                },
                {
                  label: "Open a folder",
                  keys: formatChord("mod+o"),
                  onSelect: () => void actions.pickWorkspace(),
                },
              ]}
            />
          )
        ) : searchActive ? (
          <div className="pt-1">
            {matched.slice(0, 80).map((ref) => (
              <ThreadRow key={ref.path} threadRef={ref} showFolder />
            ))}
          </div>
        ) : (
          <>
            {held.length > 0 ? (
              <section className="pt-1 pb-2">
                <p className="flex h-7 items-center gap-1.5 px-1.5 text-label font-medium text-faint">
                  <PinIcon className="size-3 fill-current opacity-60" />
                  Pinned
                </p>
                {shownPinned.map((ref) => (
                  <ThreadRow key={ref.path} threadRef={ref} showFolder />
                ))}
                {hiddenPinned > 0 || showAllPinned ? (
                  <button
                    type="button"
                    onClick={() => setShowAllPinned((current) => !current)}
                    className="flex h-6 w-full items-center rounded-md pl-7 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
                  >
                    {showAllPinned ? "Fewer pinned" : `${hiddenPinned} more pinned`}
                  </button>
                ) : null}
              </section>
            ) : null}
            {shownProjects.map((folder) => (
              <FolderSection
                key={folder.key}
                folder={folder}
                now={now}
                collapsed={collapsed.includes(`ws:${folder.key}`)}
                onToggle={() => {
                  const key = `ws:${folder.key}`
                  setPref(
                    "collapsedGroups",
                    collapsed.includes(key)
                      ? collapsed.filter((entry) => entry !== key)
                      : [...collapsed, key]
                  )
                }}
                onPin={() => {
                  if (folder.cwd) togglePinnedProject(folder.cwd)
                }}
                pages={pages[folder.key] ?? 0}
                onPages={(next) => setPages((prev) => ({ ...prev, [folder.key]: next }))}
              />
            ))}
            {hiddenProjects > 0 || showAllProjects ? (
              <button
                type="button"
                onClick={() => setShowAllProjects((current) => !current)}
                className="mb-1 flex h-7 w-full items-center rounded-md px-1.5 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
              >
                {showAllProjects ? "Fewer projects" : `${hiddenProjects} more projects`}
              </button>
            ) : null}
            {sessions ? (
              <FolderSection
                folder={sessions}
                now={now}
                collapsed={collapsed.includes(`ws:${sessions.key}`)}
                onToggle={() => {
                  const key = `ws:${sessions.key}`
                  setPref(
                    "collapsedGroups",
                    collapsed.includes(key)
                      ? collapsed.filter((entry) => entry !== key)
                      : [...collapsed, key]
                  )
                }}
                pages={pages[sessions.key] ?? 0}
                onPages={(next) =>
                  setPages((prev) => ({ ...prev, [sessions.key]: next }))
                }
              />
            ) : null}
          </>
        )}
      </div>
      </div>
    </div>
  )
}

/**
 * The catalog warming up, drawn as the thing it is about to become: two
 * folder groups, a few rows each. Bars breathe together on one slow pulse
 * and stagger their widths so the shape reads as content, not as stripes.
 */
function RailSkeleton() {
  const widths = [72, 54, 63, 78, 48]
  return (
    <div className="pt-1" aria-hidden>
      {[0, 1].map((group) => (
        <div key={group} className="pb-2">
          <div className="flex h-7 items-center gap-1.5 px-1.5">
            <span className="skeleton size-3.5" />
            <span className="skeleton h-2.5" style={{ width: group === 0 ? 64 : 88 }} />
          </div>
          {widths.slice(0, group === 0 ? 4 : 3).map((width, row) => (
            <div key={row} className="flex h-7 items-center gap-2 pl-[26px] pr-2">
              <span className="skeleton size-3 rounded-full" />
              <span
                className="skeleton h-2.5"
                style={{ width: `${width}%`, opacity: 1 - (group * 4 + row) * 0.09 }}
              />
              <span className="skeleton ml-auto h-2 w-6 opacity-60" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The mark a session wears while it is attached — running in a background
 * tab of this window. The old tab strip carried these; the rail does now.
 * A leaf with its own narrow selector: a background tab's progress repaints
 * one dot, never the list. Detach appears on hover; the row itself keeps
 * meaning "bring this forward".
 */
const Attached = memo(function Attached({ path }: { path: string }) {
  const tab = useTabs(
    useCallback(
      (state: { tabs: TabInfo[]; activeId: string }) => {
        const found = state.tabs.find((entry) => entry.sessionFile === path)
        if (!found) return null
        return {
          id: found.id,
          working: found.working,
          unread: found.unread,
          active: found.id === state.activeId,
          only: state.tabs.length < 2,
        }
      },
      [path]
    ),
    shallowEqual
  )
  if (!tab) return null
  return (
    <>
      {tab.working ? (
        <span aria-label="Working" className="size-1.5 shrink-0 animate-live rounded-full bg-ember" />
      ) : tab.unread && !tab.active ? (
        <span aria-label="Finished while you were away" className="size-1.5 shrink-0 rounded-full bg-foreground/45" />
      ) : null}
      {tab.only ? null : (
        <span
          role="button"
          tabIndex={-1}
          aria-label="Detach"
          title="Detach — stop holding this session open in the background"
          onClick={(event) => {
            event.stopPropagation()
            void actions.closeTab(tab.id)
          }}
          className="shrink-0 rounded p-0.5 text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-foreground"
        >
          <XIcon className="size-3" />
        </span>
      )}
    </>
  )
})

function ActiveAgents({ activity }: { activity: AgentActivity[] }) {
  if (activity.length === 0) return null
  return (
    <div className="flex h-7 items-center gap-2 overflow-x-auto px-3 text-label text-faint">
      {activity.map((entry) => (
        <span key={entry.harness} className="flex shrink-0 items-center gap-1.5">
          <HarnessIcon harness={entry.harness} className="size-3" />
          <span>{harnessLabel(entry.harness)}</span>
          <span className="size-1.5 animate-live rounded-full bg-current" />
          {entry.count > 1 ? <span>{entry.count} active</span> : <span>active</span>}
        </span>
      ))}
    </div>
  )
}

/**
 * The rail's one header line: an eyebrow, and two glyphs that expand into
 * search and the provider filter only when wanted. While searching, the whole
 * line becomes the input — space is spent on what is being done.
 */
function RailHeader({
  searching,
  query,
  onQuery,
  onToggleSearch,
  counts,
  filter,
}: {
  searching: boolean
  query: string
  onQuery: (value: string) => void
  onToggleSearch: (next: boolean) => void
  counts: Map<string, number>
  filter: string[]
}) {
  const input = useRef<HTMLInputElement | null>(null)

  if (searching) {
    return (
      <div className="flex h-9 shrink-0 items-center gap-1 px-2 pt-1.5">
        <SearchIcon className="ml-1.5 size-3.5 shrink-0 text-faint" />
        <input
          ref={input}
          autoFocus
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              onToggleSearch(false)
            }
          }}
          placeholder="Search every thread"
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-ui text-foreground placeholder:text-faint focus:outline-none"
        />
        <button
          type="button"
          aria-label="Close search"
          onClick={() => onToggleSearch(false)}
          className="pressable rounded p-1 text-faint hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-9 shrink-0 items-center px-2 pt-1.5">
      <span className="px-1.5 text-label font-medium text-faint">Workspaces</span>
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Search threads"
        onClick={() => onToggleSearch(true)}
        className="pressable rounded-md p-1.5 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
      >
        <SearchIcon className="size-3.5" />
      </button>
      <HarnessFilter counts={counts} filter={filter} />
      <button
        type="button"
        aria-label="Open a folder"
        title="Open a folder"
        onClick={() => void actions.pickWorkspace()}
        className="pressable rounded-md p-1.5 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
      >
        <FolderPlusIcon className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Filter and sort, one glyph. Three sections: which agents (multi-select
 * with counts), what order (activity, birth, name), and how far (every
 * folder, or only the one being worked). The glyph carries a dot while any
 * narrowing is on, so a filtered rail never reads as an empty machine.
 */
function HarnessFilter({ counts, filter }: { counts: Map<string, number>; filter: string[] }) {
  const [open, setOpen] = useState(false)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const scope = usePrefs((prefs) => prefs.railScope)
  const on = filter.length > 0 || scope === "workspace" || (sortBy !== "recent" && sortBy !== "size")

  const section = "px-2 pt-2 pb-1 text-label font-medium text-faint/80"
  const row = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui transition-colors duration-100",
      active ? "bg-fill-selected text-foreground" : "text-foreground/85 hover:bg-fill-hover"
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Filter and sort"
          className={cn(
            "pressable relative rounded-md p-1.5 transition-colors duration-100 hover:bg-fill-hover",
            on ? "text-foreground" : "text-faint hover:text-foreground"
          )}
        >
          <ListFilterIcon className="size-3.5" />
          {on ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-56 p-1">
        <p className={section}>Agents</p>
        {[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([harness, count]) => {
            const active = filter.includes(harness)
            return (
              <button
                key={harness}
                type="button"
                onClick={() =>
                  setPref(
                    "agentHarnessFilter",
                    active ? filter.filter((entry) => entry !== harness) : [...filter, harness]
                  )
                }
                className={row(active)}
              >
                <HarnessIcon harness={harness} className="size-3.5" tinted={active} />
                <span className="flex-1">{harnessLabel(harness)}</span>
                {active ? <CheckIcon className="size-3 text-foreground" /> : null}
                <span className="tabular text-label text-faint">{count}</span>
              </button>
            )
          })}

        <p className={section}>Order</p>
        {(
          [
            ["recent", "Latest activity"],
            ["created", "Newest first"],
            ["name", "By name"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setPref("railSortBy", value)}
            className={row(sortBy === value)}
          >
            <span className="flex-1">{label}</span>
            {sortBy === value ? <CheckIcon className="size-3 text-foreground" /> : null}
          </button>
        ))}

        <p className={section}>Folders</p>
        {(
          [
            ["all", "Every folder"],
            ["workspace", "This folder only"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setPref("railScope", value)}
            className={row(scope === value)}
          >
            <span className="flex-1">{label}</span>
            {scope === value ? <CheckIcon className="size-3 text-foreground" /> : null}
          </button>
        ))}

        {on ? (
          <button
            type="button"
            onClick={() => {
              setPref("agentHarnessFilter", [])
              setPref("railSortBy", "recent")
              setPref("railScope", "all")
              setOpen(false)
            }}
            className="mt-1 flex w-full items-center justify-center rounded-md border-t border-hairline px-2 py-1.5 text-label text-faint hover:text-foreground"
          >
            Reset
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * One folder of conversations. The current workspace opens wide; recent
 * folders show a few; cold folders rest as a single line. "More" unfolds
 * the tail in place — the grid-rows trick animates to unknown heights.
 */
function FolderSection({
  folder,
  now,
  collapsed,
  onToggle,
  onPin,
  pages,
  onPages,
}: {
  folder: Folder
  now: number
  collapsed: boolean
  onToggle: () => void
  onPin?: () => void
  pages: number
  onPages: (next: number) => void
}) {
  // A cold folder starts closed, a warm one open; the stored flag means
  // "the user flipped this one from its default", so both kinds remember.
  const cold =
    !folder.current && folder.latest !== "" && now - Date.parse(folder.latest) > COLD_MS
  const closed = collapsed ? !cold : cold

  const lead = folder.current ? LEAD_ROWS : REST_ROWS
  const visible = folder.refs.slice(0, lead + pages * PAGE_ROWS)
  const hidden = folder.refs.length - visible.length

  return (
    <section className="pb-1">
      <div className="group/folder flex h-7 w-full items-center rounded-md transition-colors duration-100 hover:bg-fill-hover">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-1.5 text-left"
        >
          {closed ? (
            <FolderIcon className="size-3.5 shrink-0 text-faint" />
          ) : (
            <FolderOpenIcon className="size-3.5 shrink-0 text-faint" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-ui",
              folder.current ? "font-medium text-foreground" : "text-foreground/80"
            )}
          >
            {folder.name}
          </span>
          <span className="tabular text-label text-faint/60 opacity-0 transition-opacity duration-100 group-hover/folder:opacity-100">
            {folder.refs.length}
          </span>
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-faint/50 transition-transform duration-200 ease-out",
              !closed && "rotate-90"
            )}
          />
        </button>
        {onPin ? (
          <button
            type="button"
            aria-label={folder.pinned ? "Unpin project" : "Pin project"}
            onClick={onPin}
            className={cn(
              "mr-1 rounded p-0.5 text-faint transition-opacity duration-150 hover:text-foreground",
              folder.pinned
                ? "text-foreground/70"
                : "opacity-0 group-hover/folder:opacity-100 focus:opacity-100"
            )}
          >
            <PinIcon className={cn("size-3", folder.pinned && "fill-current")} />
          </button>
        ) : null}
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          closed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {visible.map((ref) => (
            <ThreadRow key={ref.path} threadRef={ref} indent />
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => onPages(pages + 1)}
              className="flex h-6 w-full items-center rounded-md pl-8 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
            >
              More
              <span className="tabular ml-1 text-label text-faint/60">{hidden}</span>
            </button>
          ) : pages > 0 ? (
            <button
              type="button"
              onClick={() => onPages(0)}
              className="flex h-6 w-full items-center rounded-md pl-8 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
            >
              Less
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

const ThreadRow = memo(function ThreadRow({
  threadRef: ref,
  indent,
  showFolder,
}: {
  threadRef: ThreadRef
  indent?: boolean
  showFolder?: boolean
}) {
  const override = usePrefs((prefs) => prefs.titleOverrides[ref.path])
  const [editing, setEditing] = useState<string | null>(null)
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  const activity = useThreads((state) => threadActivity(ref, state))
  const working = activity === "mako"
  const lockedElsewhere =
    activity === "external-open" || activity === "external-active"
  const activeElsewhere =
    activity === "observed" || activity === "external-active"
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(ref.path))
  const active = useSession((state) => state.meta?.sessionFile === ref.path)
  const viewingPath = useThreads((state) => state.viewing?.ref.path)

  const open = () => {
    void threads.view(ref)
  }

  // One selection at a time: while a thread is open in the viewer, IT is
  // the selection — the native tab keeps its state but not its highlight,
  // because two lit rows read as a broken click.
  const lit = viewingPath ? viewingPath === ref.path : active

  return (
    <button
      type="button"
      onClick={open}
      onAuxClick={(event) => {
        if (event.button === 1) open()
      }}
      title={[
        ref.title ?? "Untitled session",
        ref.archived ? "Archived: the native store lost this; Mako kept it. Reply to bring it back to life." : undefined,
        [...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)), harnessLabel(ref.harness)].join(" → "),
        ref.model,
        ref.cwd,
      ]
        .filter(Boolean)
        .join("\n")}
      data-active={lit || undefined}
      className={cn(
        "group flex h-7 w-full items-center gap-2 rounded-md pr-1.5 text-left",
        indent ? "pl-[26px]" : "pl-1.5",
        "transition-colors duration-100 hover:bg-fill-hover data-active:bg-raised"
      )}
    >
      {/* Where this conversation has lived: earlier harnesses dimmed and
          tucked behind, the current one in front. One mark when it has
          only ever been one place — which is most sessions. */}
      <span className="flex shrink-0 items-center -space-x-1">
        {(ref.lineage ?? []).slice(-1).map((origin, index) => (
          <HarnessIcon
            key={`${origin.harness}-${index}`}
            harness={origin.harness}
            className="size-3 opacity-40"
          />
        ))}
        <HarnessIcon
          harness={ref.harness}
          className={cn("size-3", (working || activeElsewhere) && "animate-live")}
        />
      </span>
      {editing !== null ? (
        <input
          autoFocus
          value={editing}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              const next = editing.trim()
              const all = { ...prefsStore.get().titleOverrides }
              if (next && next !== ref.title) all[ref.path] = next
              else delete all[ref.path]
              setPref("titleOverrides", all)
              setEditing(null)
            }
            if (event.key === "Escape") setEditing(null)
          }}
          onBlur={() => setEditing(null)}
          className="min-w-0 flex-1 rounded bg-raised px-1 text-ui text-foreground ring-1 ring-hairline focus:outline-none"
        />
      ) : (
        <span
          onDoubleClick={(event) => {
            event.stopPropagation()
            setEditing(override ?? ref.title ?? "")
          }}
          title="Double-click to rename"
          className={cn(
            "min-w-0 flex-1 truncate text-ui",
            lit ? "font-medium text-foreground" : "text-foreground/85"
          )}
        >
          {override ?? ref.title ?? "Untitled session"}
        </span>
      )}
      {showFolder && ref.cwd ? (
        <span className="max-w-[6rem] shrink-0 truncate text-label text-faint/70">
          {workspaceName(ref.cwd)}
        </span>
      ) : null}
      <span
        role="button"
        tabIndex={-1}
        aria-label={isPinned ? "Unpin" : "Pin"}
        onClick={(event) => {
          event.stopPropagation()
          togglePinned(ref.path)
        }}
        className={cn(
          "shrink-0 rounded p-0.5 transition-opacity duration-150",
          isPinned
            ? "text-foreground/70"
            : "text-faint opacity-0 group-hover:opacity-100 hover:text-foreground"
        )}
      >
        <PinIcon className={cn("size-3", isPinned && "fill-current")} />
      </span>
      <Attached path={ref.path} />
      {ref.archived ? (
        <ArchiveIcon
          className="size-3 shrink-0 text-faint/70"
          aria-label="Archived — the native session is gone; Mako kept the conversation"
        />
      ) : null}
      {working ? (
        <Loader2Icon
          className="size-3 shrink-0 animate-spin text-ember/80"
          aria-label="Working in Mako"
        />
      ) : activeElsewhere ? (
        <Loader2Icon
          className="size-3 shrink-0 animate-spin text-foreground/45"
          aria-label={
            lockedElsewhere ? "Active in another app" : "Live activity"
          }
        />
      ) : lockedElsewhere ? (
        <LockKeyholeIcon
          className="size-3 shrink-0 text-faint/70"
          aria-label="Open in another app"
        />
      ) : ref.updatedAt ? (
        <span className="tabular shrink-0 text-label text-faint">
          {formatRelative(ref.updatedAt)}
        </span>
      ) : null}
    </button>
  )
})
