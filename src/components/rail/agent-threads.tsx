import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RunningThreads } from "@/components/rail/active-threads"
import { ThreadRow } from "@/components/rail/thread-row"
import { harnessLabel } from "@/components/rail/harness-meta"
import { formatRelative } from "@/lib/format"
import {
  groupThreadFolders,
  threadBelongsToWorkspace,
  type ThreadFolder,
} from "@/lib/thread-folders"
import {
  activeThreadRefs,
  threadStatus,
  threadStatusPriority,
  threadsStore,
  useThreads,
} from "@/state/threads"
import { actions, useSession } from "@/state/session"
import { useAcp } from "@/state/acp"
import {
  sameAcpPresence,
  selectAcpPresence,
} from "@/state/acp-presence"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import {
  setPref,
  togglePinnedProject,
  usePrefs,
} from "@/state/prefs"
import { cn } from "@/lib/utils"
import { Blank } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { DraftThreads } from "@/components/rail/draft-threads"
import {
  FolderActivity,
  RailSkeleton,
} from "@/components/rail/rail-activity"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ListFilterIcon,
  MessagesSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

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
const FOLDER_ROWS = 6
/** Folders quiet longer than this start out collapsed. */
const COLD_MS = 7 * 24 * 3600_000
const LIVE_TIME_MS = 60_000
const INITIAL_TIME = Date.now()

function useLiveTime(): number {
  const [now, setNow] = useState(INITIAL_TIME)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TIME_MS)
    return () => window.clearInterval(timer)
  }, [])

  return now
}

export function AgentThreads() {
  const rail = useRef<HTMLDivElement>(null)
  const topFade = useRef<HTMLSpanElement>(null)
  const [query, setQuery] = useState("")
  const [jumpHints, setJumpHints] = useState(false)
  const [searching, setSearching] = useState(false)
  const [showAllPinned, setShowAllPinned] = useState(false)
  const [showAllFolders, setShowAllFolders] = useState(false)
  // Extra pages unfolded per folder — More reveals a handful at a time,
  // not the whole archive in one avalanche.
  const [pages, setPages] = useState<Record<string, number>>({})
  const deferred = useDeferredValue(query)
  const all = useThreads((state) => state.threads)
  const liveAgents = useAcp(selectAcpPresence, sameAcpPresence)
  const loaded = useThreads((state) => state.loaded)
  const working = useThreads((state) => state.working)
  const attention = useThreads((state) => state.attention)
  const observed = useThreads((state) => state.observed)
  const filter = usePrefs((prefs) => prefs.agentHarnessFilter)
  const pinned = usePrefs((prefs) => prefs.pinnedThreads)
  const pinnedProjects = usePrefs((prefs) => prefs.pinnedProjects)
  const collapsed = usePrefs((prefs) => prefs.collapsedGroups)
  const scope = usePrefs((prefs) => prefs.railScope)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const { cwd, ready: workspaceReady } = useWorkspaceFocus()
  const branch = useSession((state) => state.git?.branch)
  const focusedBranch = workspaceReady ? branch : undefined
  const now = useLiveTime()

  useEffect(() => {
    const search = () => setSearching(true)
    window.addEventListener("mako:search-threads", search)
    return () => window.removeEventListener("mako:search-threads", search)
  }, [])

  useEffect(() => {
    const rows = () =>
      [...(rail.current?.querySelectorAll<HTMLElement>("[data-thread-row]") ?? [])].filter(
        (row) => row.offsetParent !== null
      )
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      const mod = event.metaKey || event.ctrlKey
      setJumpHints(mod && event.shiftKey)
      if (!mod || !event.shiftKey || !event.code.startsWith("Digit")) return
      const index = Number(event.code.slice(5)) - 1
      const row = rows()[index]
      if (!row || index < 0 || index > 8) return
      event.preventDefault()
      row.click()
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey)
        setJumpHints(false)
    }
    const onBlur = () => setJumpHints(false)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  const counts = useMemo(() => {
    const byHarness = new Map<string, number>()
    for (const ref of all) {
      byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
    }
    return byHarness
  }, [all])

  const activeThreads = useMemo(
    () =>
      activeThreadRefs(all, {
        ...threadsStore.get(),
        attention,
        observed,
        working,
      }),
    [all, attention, observed, working]
  )
  const activePaths = useMemo(
    () => new Set(activeThreads.map((ref) => ref.path)),
    [activeThreads]
  )
  const unboundLiveAgents = useMemo(() => {
    const nativePaths = new Set(all.map((ref) => ref.path))
    const nativeIdentities = new Set(
      all.map((ref) => `${ref.harness}:${ref.nativeId}`)
    )
    return liveAgents.filter(
      (presence) =>
        (!presence.threadPath || !nativePaths.has(presence.threadPath)) &&
        (!presence.nativeId ||
          !nativeIdentities.has(`${presence.harness}:${presence.nativeId}`))
    )
  }, [all, liveAgents])

  const matched = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    const active = filter.length > 0 ? new Set(filter) : null
    return all.filter(
      (ref) =>
        (scope !== "workspace" || threadBelongsToWorkspace(ref, cwd)) &&
        (!active || active.has(ref.harness)) &&
        (!needle ||
          `${ref.title ?? ""} ${ref.cwd ?? ""} ${harnessLabel(ref.harness)} ${ref.model ?? ""}`
            .toLowerCase()
            .includes(needle))
    )
  }, [all, cwd, deferred, filter, scope])

  const { priorities, threadActivity } = useMemo(() => {
    const state = { ...threadsStore.get(), attention, observed, working }
    const nextPriorities: Record<string, number> = {}
    const nextActivity: Record<
      string,
      {
        running?: boolean
        needsInput?: boolean
        failed?: boolean
        unread?: boolean
        active?: boolean
      }
    > = {}
    for (const ref of matched) {
      const status = threadStatus(ref, state)
      nextPriorities[ref.path] = threadStatusPriority(status)
      nextActivity[ref.path] = {
        running: Boolean(working[ref.path]),
        needsInput: status.kind === "needs-permission",
        failed: status.kind === "failed",
        unread: status.kind === "review" && status.unread,
        active:
          status.kind === "observed" || status.kind === "external-active",
      }
    }
    return { priorities: nextPriorities, threadActivity: nextActivity }
  }, [attention, matched, observed, working])

  const held = useMemo(() => {
    const set = new Set(pinned)
    const list = matched.filter((ref) => set.has(ref.path))
    list.sort((a, b) => pinned.indexOf(a.path) - pinned.indexOf(b.path))
    return list
  }, [matched, pinned])

  const folders = useMemo(
    () =>
      groupThreadFolders({
        refs: matched,
        currentCwd: cwd,
        pinnedThreads: pinned,
        pinnedFolders: pinnedProjects,
        priorities,
        activity: threadActivity,
        sortBy,
      }),
    [cwd, matched, pinned, pinnedProjects, priorities, sortBy, threadActivity]
  )

  const searchActive = Boolean(deferred.trim())
  const quietPinned = held.filter((ref) => !activePaths.has(ref.path))
  const shownPinned = showAllPinned
    ? quietPinned
    : quietPinned.slice(0, PINNED_ROWS)
  const hiddenPinned = quietPinned.length - shownPinned.length
  const workspaceFolders = folders.filter((folder) => folder.cwd !== null)
  const sessions = folders.find((folder) => folder.cwd === null)
  const priorityFolders = workspaceFolders.filter(
    (folder) => folder.current || folder.pinned
  ).length
  const shownFolders = showAllFolders
    ? workspaceFolders
    : workspaceFolders.slice(0, Math.max(FOLDER_ROWS, priorityFolders))
  const hiddenFolders = workspaceFolders.length - shownFolders.length

  useEffect(() => {
    const rows = rail.current?.querySelectorAll<HTMLElement>("[data-thread-row]")
    rows?.forEach((row, index) => {
      if (index < 9) row.dataset.jumpIndex = String(index + 1)
      else delete row.dataset.jumpIndex
    })
  }, [folders, held, jumpHints, matched, pages, showAllPinned, showAllFolders])

  return (
    <div
      ref={rail}
      data-jump-hints={jumpHints || undefined}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
        const current =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>("[data-thread-row]")
            : null
        if (!current) return
        const rows = [
          ...(rail.current?.querySelectorAll<HTMLElement>("[data-thread-row]") ?? []),
        ].filter((row) => row.offsetParent !== null)
        const at = rows.indexOf(current)
        const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)]
        if (!next) return
        event.preventDefault()
        next.focus()
      }}
      className="thread-jump-scope flex min-h-0 flex-1 flex-col"
    >
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
      <div className="scroll-fade-scope flex min-h-0 flex-1 flex-col">
        <span
          ref={topFade}
          aria-hidden
          className="scroll-fade-top [--fade-from:var(--shell)]"
        />
        <div
          onScroll={(event) =>
            topFade.current?.toggleAttribute(
              "data-scrolled",
              event.currentTarget.scrollTop > 0.5
            )
          }
          className="scroll-fade-scroller min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
        >
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
            <DraftThreads />
            <RunningThreads refs={activeThreads} liveAgents={unboundLiveAgents} />
            {quietPinned.length > 0 ? (
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
            {shownFolders.map((folder) => (
              <FolderSection
                key={folder.key}
                folder={folder}
                branch={folder.current ? focusedBranch : undefined}
                now={now}
                hiddenPaths={activePaths}
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
                onNew={() => {
                  if (folder.cwd) void actions.newConversationIn(folder.cwd)
                }}
                onPin={() => {
                  if (folder.cwd) togglePinnedProject(folder.cwd)
                }}
                pages={pages[folder.key] ?? 0}
                onPages={(next) => setPages((prev) => ({ ...prev, [folder.key]: next }))}
              />
            ))}
            {hiddenFolders > 0 || showAllFolders ? (
              <button
                type="button"
                onClick={() => setShowAllFolders((current) => !current)}
                className="mb-1 flex h-7 w-full items-center rounded-md px-1.5 text-left text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-muted-foreground"
              >
                {showAllFolders ? "Fewer folders" : `${hiddenFolders} more folders`}
              </button>
            ) : null}
            {sessions ? (
              <FolderSection
                folder={sessions}
                now={now}
                hiddenPaths={activePaths}
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
          aria-label="Search every thread"
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
  const on = filter.length > 0 || scope === "workspace" || sortBy !== "recent"

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
  branch,
  now,
  hiddenPaths,
  collapsed,
  onToggle,
  onNew,
  onPin,
  pages,
  onPages,
}: {
  folder: ThreadFolder
  branch?: string
  now: number
  hiddenPaths: ReadonlySet<string>
  collapsed: boolean
  onToggle: () => void
  onNew?: () => void
  onPin?: () => void
  pages: number
  onPages: (next: number) => void
}) {
  // A cold folder starts closed, a warm one open; the stored flag means
  // "the user flipped this one from its default", so both kinds remember.
  const cold =
    !folder.current &&
    !folder.priority &&
    folder.latest !== "" &&
    now - Date.parse(folder.latest) > COLD_MS
  const closed = collapsed ? !cold : cold
  const contentId = `folder-${folder.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`

  const lead = folder.current ? LEAD_ROWS : REST_ROWS
  const available = folder.refs.filter((ref) => !hiddenPaths.has(ref.path))
  const visible = available.slice(0, lead + pages * PAGE_ROWS)
  const hidden = available.length - visible.length

  return (
    <section className="pb-1">
      <div className="group/folder flex h-7 w-full items-center rounded-md transition-colors duration-100 hover:bg-fill-hover">
        <button
          type="button"
          title={folder.cwd ?? folder.name}
          aria-expanded={!closed}
          aria-controls={contentId}
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
          {branch ? (
            <span
              title={branch}
              className="max-w-24 shrink-0 truncate font-mono text-label text-faint/70"
            >
              {branch}
            </span>
          ) : null}
          <FolderActivity folder={folder} />
          {!folder.priority && folder.latest ? (
            <span className="tabular shrink-0 text-label text-faint/60">
              {formatRelative(folder.latest)}
            </span>
          ) : null}
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
        {onNew ? (
          <button
            type="button"
            aria-label={`New session in ${folder.name}`}
            title={`New session in ${folder.name}`}
            onClick={onNew}
            className="pressable rounded p-0.5 text-faint transition-colors duration-100 hover:bg-background/40 hover:text-foreground"
          >
            <PlusIcon className="size-3" />
          </button>
        ) : null}
        {onPin ? (
          <button
            type="button"
            aria-label={folder.pinned ? "Unpin folder" : "Pin folder"}
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
        id={contentId}
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
