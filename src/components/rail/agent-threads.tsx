import { memo, useDeferredValue, useMemo, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatRelative, workspaceName } from "@/lib/format"
import { threads, useThreads } from "@/state/threads"
import { actions, useSession } from "@/state/session"
import { setPref, togglePinned, usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  ArchiveIcon,
  FolderPlusIcon,
  ListFilterIcon,
  PinIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import type { Harness, ThreadRef } from "@/lib/types"

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

export const HARNESS_LABEL: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  devin: "Devin",
}

/**
 * What a session should read as. A Pi session whose model comes from the
 * pi-devin provider is a Devin-local conversation — it wears Devin's mark
 * and counts under Devin's chip, because that is who was answering.
 */
export function displayHarness(ref: ThreadRef): string {
  return ref.harness === "pi" && ref.modelProvider === "devin" ? "devin" : ref.harness
}

export function harnessLabel(harness: Harness): string {
  return HARNESS_LABEL[harness] ?? harness
}

/** Rows a folder shows before "More": generous for the folder being worked. */
const LEAD_ROWS = 5
const REST_ROWS = 3
/** Folders quiet longer than this start out collapsed. */
const COLD_MS = 7 * 24 * 3600_000

interface Folder {
  key: string
  name: string
  cwd: string | null
  refs: ThreadRef[]
  current: boolean
  latest: string
}

export function AgentThreads() {
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const deferred = useDeferredValue(query)
  const all = useThreads((state) => state.threads)
  const loaded = useThreads((state) => state.loaded)
  const filter = usePrefs((prefs) => prefs.agentHarnessFilter)
  const pinned = usePrefs((prefs) => prefs.pinnedThreads)
  const collapsed = usePrefs((prefs) => prefs.collapsedGroups)
  const scope = usePrefs((prefs) => prefs.railScope)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const cwd = useSession((state) => state.meta?.cwd)

  // The haystack is built once per catalog push, not once per keystroke.
  const indexed = useMemo(
    () =>
      all.map((ref) => ({
        ref,
        haystack:
          `${ref.title ?? ""} ${ref.cwd ?? ""} ${harnessLabel(displayHarness(ref))} ${ref.model ?? ""}`.toLowerCase(),
      })),
    [all]
  )

  const counts = useMemo(() => {
    const byHarness = new Map<string, number>()
    for (const entry of indexed) {
      const harness = displayHarness(entry.ref)
      byHarness.set(harness, (byHarness.get(harness) ?? 0) + 1)
    }
    return byHarness
  }, [indexed])

  const matched = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    const active = filter.length > 0 ? new Set(filter) : null
    return indexed
      .filter(
        (entry) =>
          (scope !== "workspace" || !cwd || entry.ref.cwd === cwd) &&
          (!active || active.has(displayHarness(entry.ref))) &&
          (!needle || entry.haystack.includes(needle))
      )
      .map((entry) => entry.ref)
  }, [cwd, deferred, filter, indexed, scope])

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
    const result: Folder[] = [...byCwd.entries()].map(([key, refs]) => {
      refs.sort(byOrder)
      return {
        key: key || "~",
        name: key ? workspaceName(key) : "No folder",
        cwd: key || null,
        refs,
        current: Boolean(cwd) && key === cwd,
        latest: refs.reduce((top, ref) => ((ref.updatedAt ?? "") > top ? ref.updatedAt! : top), ""),
      }
    })
    result.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      if (sortBy === "name") return a.name.localeCompare(b.name)
      return b.latest.localeCompare(a.latest)
    })
    return result
  }, [cwd, matched, pinned, sortBy])

  const searchActive = Boolean(deferred.trim())

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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {!loaded && matched.length === 0 ? (
          <RailSkeleton />
        ) : matched.length === 0 ? (
          <p className="px-3 pt-8 text-center text-[11.5px] leading-relaxed text-faint">
            {searchActive || filter.length > 0
              ? "Nothing matches."
              : "No conversations yet — from any agent."}
          </p>
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
                <p className="flex h-7 items-center gap-1.5 px-1.5 text-[10.5px] font-medium text-faint">
                  <PinIcon className="size-3 fill-current opacity-60" />
                  Pinned
                </p>
                {held.map((ref) => (
                  <ThreadRow key={ref.path} threadRef={ref} showFolder />
                ))}
              </section>
            ) : null}
            {folders.map((folder) => (
              <FolderSection
                key={folder.key}
                folder={folder}
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
                showingAll={Boolean(showAll[folder.key])}
                onShowAll={(next) => setShowAll((prev) => ({ ...prev, [folder.key]: next }))}
              />
            ))}
          </>
        )}
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
    <div className="animate-pulse pt-1" aria-hidden>
      {[0, 1].map((group) => (
        <div key={group} className="pb-2">
          <div className="flex h-7 items-center gap-1.5 px-1.5">
            <span className="size-3.5 rounded-[4px] bg-raised" />
            <span
              className="h-2.5 rounded-full bg-raised"
              style={{ width: group === 0 ? 64 : 88 }}
            />
          </div>
          {widths.slice(0, group === 0 ? 4 : 3).map((width, row) => (
            <div key={row} className="flex h-7 items-center gap-2 pl-[26px] pr-2">
              <span className="size-3 rounded-full bg-raised" />
              <span
                className="h-2.5 rounded-full bg-raised"
                style={{ width: `${width}%`, opacity: 1 - (group * 4 + row) * 0.09 }}
              />
              <span className="ml-auto h-2 w-6 rounded-full bg-raised opacity-60" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The rail's one header line: an eyebrow, and two glyphs that expand into
 * search and the harness filter only when wanted. While searching, the whole
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
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[12px] text-foreground placeholder:text-faint focus:outline-none"
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
      <span className="px-1.5 text-[10.5px] font-medium tracking-wide text-faint">Workspaces</span>
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Search threads"
        onClick={() => onToggleSearch(true)}
        className="pressable rounded-md p-1.5 text-faint transition-colors duration-100 hover:bg-raised hover:text-foreground"
      >
        <SearchIcon className="size-3.5" />
      </button>
      <HarnessFilter counts={counts} filter={filter} />
      <button
        type="button"
        aria-label="Open a folder"
        title="Open a folder"
        onClick={() => void actions.pickWorkspace()}
        className="pressable rounded-md p-1.5 text-faint transition-colors duration-100 hover:bg-raised hover:text-foreground"
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

  const section = "px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-faint/80 uppercase"
  const row = (active: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors duration-100",
      active ? "bg-raised text-foreground" : "text-foreground/85 hover:bg-raised/60"
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Filter and sort"
          className={cn(
            "pressable relative rounded-md p-1.5 transition-colors duration-100 hover:bg-raised",
            on ? "text-foreground" : "text-faint hover:text-foreground"
          )}
        >
          <ListFilterIcon className="size-3.5" />
          {on ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-brand" />
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
                {active ? <CheckIcon className="size-3 text-brand" /> : null}
                <span className="tabular text-[10.5px] text-faint">{count}</span>
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
            {sortBy === value ? <CheckIcon className="size-3 text-brand" /> : null}
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
            {scope === value ? <CheckIcon className="size-3 text-brand" /> : null}
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
            className="mt-1 flex w-full items-center justify-center rounded-md border-t border-hairline px-2 py-1.5 text-[11px] text-faint hover:text-foreground"
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
  collapsed,
  onToggle,
  showingAll,
  onShowAll,
}: {
  folder: Folder
  collapsed: boolean
  onToggle: () => void
  showingAll: boolean
  onShowAll: (next: boolean) => void
}) {
  // A cold folder starts closed, a warm one open; the stored flag means
  // "the user flipped this one from its default", so both kinds remember.
  const cold =
    !folder.current && folder.latest !== "" && Date.now() - Date.parse(folder.latest) > COLD_MS
  const closed = collapsed ? !cold : cold

  const lead = folder.current ? LEAD_ROWS : REST_ROWS
  const visible = showingAll ? folder.refs : folder.refs.slice(0, lead)
  const hidden = folder.refs.length - visible.length

  return (
    <section className="pb-1">
      <button
        type="button"
        onClick={onToggle}
        className="group/folder flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left transition-colors duration-100 hover:bg-raised/50"
      >
        {closed ? (
          <FolderIcon className="size-3.5 shrink-0 text-faint" />
        ) : (
          <FolderOpenIcon className="size-3.5 shrink-0 text-faint" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            folder.current ? "font-medium text-foreground" : "text-foreground/80"
          )}
        >
          {folder.name}
        </span>
        <span className="tabular pr-0.5 text-[10px] text-faint/60 opacity-0 transition-opacity duration-100 group-hover/folder:opacity-100">
          {folder.refs.length}
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-faint/50 transition-transform duration-200 ease-out",
            !closed && "rotate-90"
          )}
        />
      </button>
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
              onClick={() => onShowAll(true)}
              className="flex h-6 w-full items-center rounded-md pl-8 text-left text-[11px] text-faint transition-colors duration-100 hover:bg-raised/50 hover:text-muted-foreground"
            >
              More
              <span className="tabular ml-1 text-[10px] text-faint/60">{hidden}</span>
            </button>
          ) : showingAll && folder.refs.length > lead ? (
            <button
              type="button"
              onClick={() => onShowAll(false)}
              className="flex h-6 w-full items-center rounded-md pl-8 text-left text-[11px] text-faint transition-colors duration-100 hover:bg-raised/50 hover:text-muted-foreground"
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
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  const working = useThreads((state) => Boolean(state.running[ref.path]))
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(ref.path))
  const active = useSession((state) => state.meta?.sessionFile === ref.path)
  const viewingPath = useThreads((state) => state.viewing?.ref.path)

  const open = (inNewTab: boolean) => {
    // Pi sessions are this app's own: open them natively, with full fidelity
    // and a live agent. Everything else opens translated, live through the
    // file tail, with every continuation one send away.
    if (ref.harness === "pi") void actions.openSession(ref.path, { inNewTab })
    else void threads.view(ref)
  }

  const lit = active || viewingPath === ref.path

  return (
    <button
      type="button"
      onClick={(event) => open(event.metaKey || event.ctrlKey || event.shiftKey)}
      onAuxClick={(event) => {
        if (event.button === 1) open(true)
      }}
      title={[
        ref.title ?? "Untitled session",
        ref.archived ? "Archived: the native store lost this; Mako kept it. Reply to bring it back to life." : undefined,
        [...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)), harnessLabel(displayHarness(ref))].join(" → "),
        ref.model,
        ref.cwd,
      ]
        .filter(Boolean)
        .join("\n")}
      data-active={lit || undefined}
      className={cn(
        "group flex h-7 w-full items-center gap-2 rounded-md pr-1.5 text-left",
        indent ? "pl-[26px]" : "pl-1.5",
        "transition-colors duration-100 hover:bg-raised data-active:bg-raised"
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
          harness={displayHarness(ref)}
          className={cn("size-3", working && "animate-pulse")}
        />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12.5px]",
          lit ? "font-medium text-foreground" : "text-foreground/85"
        )}
      >
        {ref.title ?? "Untitled session"}
      </span>
      {showFolder && ref.cwd ? (
        <span className="max-w-[6rem] shrink-0 truncate text-[10px] text-faint/70">
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
      {ref.archived ? (
        <ArchiveIcon
          className="size-3 shrink-0 text-faint/70"
          aria-label="Archived — the native session is gone; Mako kept the conversation"
        />
      ) : null}
      {working ? (
        <span className="shrink-0 text-[10px] text-faint">working…</span>
      ) : ref.updatedAt ? (
        <span className="tabular shrink-0 text-[10px] text-faint">
          {formatRelative(ref.updatedAt)}
        </span>
      ) : null}
    </button>
  )
})
