import { memo, useDeferredValue, useMemo, useState } from "react"
import { formatRelative, workspaceName } from "@/lib/format"
import { threads, useThreads } from "@/state/threads"
import { actions } from "@/state/session"
import { setPref, togglePinned, usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { PinIcon, SearchIcon, XIcon } from "lucide-react"
import type { Harness, ThreadRef } from "@/lib/types"

/**
 * Every agent's conversations, not just this app's.
 *
 * The host watches the native session stores of every harness on the machine
 * — Codex, Claude Code, Cursor, Grok, Pi — so this list is live: run
 * something in a terminal on the other monitor and it appears here
 * mid-turn. A Pi session opens natively; any other harness opens in a
 * read-only viewer with the conversation translated, from which it can be
 * continued here.
 */

export const HARNESS_LABEL: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  devin: "Devin",
}

export function harnessLabel(harness: Harness): string {
  return HARNESS_LABEL[harness] ?? harness
}

export function AgentThreads() {
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query)
  const all = useThreads((state) => state.threads)
  const loaded = useThreads((state) => state.loaded)
  const filter = usePrefs((prefs) => prefs.agentHarnessFilter)
  const pinned = usePrefs((prefs) => prefs.pinnedThreads)

  // The haystack is built once per catalog push, not once per keystroke —
  // lowering six hundred titles on every character is the difference between
  // instant and merely fast.
  const indexed = useMemo(
    () =>
      all.map((ref) => ({
        ref,
        haystack: `${ref.title ?? ""} ${ref.cwd ?? ""} ${harnessLabel(ref.harness)} ${ref.model ?? ""}`.toLowerCase(),
      })),
    [all]
  )

  const counts = useMemo(() => {
    const byHarness = new Map<string, number>()
    for (const ref of all) byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
    return byHarness
  }, [all])

  const shown = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    const active = filter.length > 0 ? new Set(filter) : null
    const matched = indexed
      .filter(
        (entry) =>
          (!active || active.has(entry.ref.harness)) &&
          (!needle || entry.haystack.includes(needle))
      )
      .map((entry) => entry.ref)
    if (needle) return { pinnedRefs: [], rest: matched }
    const set = new Set(pinned)
    const pinnedRefs = matched.filter((ref) => set.has(ref.path))
    pinnedRefs.sort((a, b) => pinned.indexOf(a.path) - pinned.indexOf(b.path))
    return { pinnedRefs, rest: matched.filter((ref) => !set.has(ref.path)) }
  }, [deferred, filter, indexed, pinned])

  const total = shown.pinnedRefs.length + shown.rest.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation()
                setQuery("")
              }
            }}
            placeholder="Search every agent's sessions"
            className="h-7 w-full rounded-md bg-surface pr-6 pl-7 text-[11.5px] text-foreground placeholder:text-faint focus:ring-1 focus:ring-hairline focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-faint hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
        <span className="tabular shrink-0 pr-0.5 text-[10.5px] text-faint">{total}</span>
      </div>

      {/* One chip per harness that actually has sessions, with its count.
          Click narrows; click again widens. Several can be on at once. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-1.5">
        {[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([harness, count]) => {
            const on = filter.includes(harness)
            return (
              <button
                key={harness}
                type="button"
                onClick={() =>
                  setPref(
                    "agentHarnessFilter",
                    on ? filter.filter((entry) => entry !== harness) : [...filter, harness]
                  )
                }
                className={cn(
                  "pressable flex h-6 items-center gap-1.5 rounded-full border px-2 text-[10.5px] transition-colors",
                  on
                    ? "border-foreground/40 bg-raised text-foreground"
                    : "border-hairline text-faint hover:text-muted-foreground"
                )}
              >
                <HarnessIcon harness={harness} className="size-3" tinted={on} />
                {harnessLabel(harness)}
                <span className="tabular text-[9.5px] opacity-70">{count}</span>
              </button>
            )
          })}
        {filter.length > 0 ? (
          <button
            type="button"
            onClick={() => setPref("agentHarnessFilter", [])}
            className="pressable h-6 rounded-full px-1.5 text-[10.5px] text-faint hover:text-foreground"
          >
            clear
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {total === 0 ? (
          <p className="px-2 pt-6 text-center text-[11.5px] leading-relaxed text-faint">
            {loaded
              ? deferred || filter.length > 0
                ? "Nothing matches."
                : "No sessions found from any agent yet."
              : "Looking through every agent's sessions…"}
          </p>
        ) : (
          <>
            {shown.pinnedRefs.length > 0 ? (
              <p className="px-2 pt-1 pb-0.5 text-[10.5px] font-medium text-faint">Pinned</p>
            ) : null}
            {shown.pinnedRefs.map((ref) => (
              <ThreadRow key={ref.path} threadRef={ref} />
            ))}
            {shown.pinnedRefs.length > 0 && shown.rest.length > 0 ? (
              <p className="px-2 pt-2 pb-0.5 text-[10.5px] font-medium text-faint">Recent</p>
            ) : null}
            {shown.rest.map((ref) => (
              <ThreadRow key={ref.path} threadRef={ref} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

const ThreadRow = memo(function ThreadRow({ threadRef: ref }: { threadRef: ThreadRef }) {
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  const working = useThreads((state) => Boolean(state.running[ref.path]))
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(ref.path))
  const open = () => {
    // Pi sessions are this app's own: open them natively, with full fidelity
    // and a live agent. Everything else opens translated, read-only, with
    // "continue here" one click away.
    if (ref.harness === "pi") void actions.openSession(ref.path, { inNewTab: true })
    else void threads.view(ref)
  }

  return (
    <button
      type="button"
      onClick={open}
      title={ref.cwd}
      className={cn(
        "group relative flex h-[42px] w-full flex-col justify-center gap-0.5 rounded-md px-2 text-left",
        "transition-colors duration-100 hover:bg-raised"
      )}
    >
      <span className="flex items-baseline gap-2">
        {/* Where this conversation has lived: earlier harnesses dimmed and
            tucked behind, the current one in front. One mark when it has
            only ever been one place — which is most sessions. */}
        <span className="flex shrink-0 items-center -space-x-1 self-center">
          {(ref.lineage ?? []).slice(-2).map((origin, index) => (
            <HarnessIcon
              key={`${origin.harness}-${index}`}
              harness={origin.harness}
              className="size-3 opacity-40"
            />
          ))}
          <HarnessIcon
            harness={ref.harness}
            className={cn("size-3", working && "animate-pulse")}
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
          {ref.title ?? "Untitled session"}
        </span>
        <span
          role="button"
          tabIndex={-1}
          aria-label={isPinned ? "Unpin" : "Pin"}
          onClick={(event) => {
            event.stopPropagation()
            togglePinned(ref.path)
          }}
          className={cn(
            "shrink-0 self-center rounded p-0.5 transition-opacity",
            isPinned
              ? "text-foreground/70"
              : "text-faint opacity-0 group-hover:opacity-100 hover:text-foreground"
          )}
        >
          <PinIcon className={cn("size-3", isPinned && "fill-current")} />
        </span>
        {working ? (
          <span className="shrink-0 text-[10.5px] text-faint">working…</span>
        ) : ref.updatedAt ? (
          <span className="tabular shrink-0 text-[10.5px] text-faint">
            {formatRelative(ref.updatedAt)}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-1.5 pl-5 text-[11px] text-faint">
        <span className="shrink-0">
          {[...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)), harnessLabel(ref.harness)].join(" → ")}
        </span>
        {ref.cwd ? (
          <>
            <span className="text-faint/50">·</span>
            <span className="min-w-0 truncate">{workspaceName(ref.cwd)}</span>
          </>
        ) : null}
        {ref.model ? (
          <>
            <span className="text-faint/50">·</span>
            <span className="min-w-0 truncate">{ref.model}</span>
          </>
        ) : null}
      </span>
    </button>
  )
})
