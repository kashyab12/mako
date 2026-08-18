import { memo, useDeferredValue, useMemo, useState } from "react"
import { formatRelative, workspaceName } from "@/lib/format"
import { threads, useThreads } from "@/state/threads"
import { actions } from "@/state/session"
import { cn } from "@/lib/utils"
import { SearchIcon, XIcon } from "lucide-react"
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

/**
 * One hue per harness, used as a 6px dot. Dots, not badges: the rail is
 * dense, and thirty colored pills would shout over the titles they label.
 */
const HARNESS_DOT: Record<string, string> = {
  pi: "bg-emerald-400/80",
  codex: "bg-sky-400/80",
  claude: "bg-orange-400/80",
  cursor: "bg-zinc-300/80",
  grok: "bg-violet-400/80",
  devin: "bg-blue-400/80",
}

export function harnessLabel(harness: Harness): string {
  return HARNESS_LABEL[harness] ?? harness
}

export function harnessDot(harness: Harness): string {
  return HARNESS_DOT[harness] ?? "bg-faint"
}

export function AgentThreads() {
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query)
  const all = useThreads((state) => state.threads)
  const loaded = useThreads((state) => state.loaded)

  const shown = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    if (!needle) return all
    return all.filter((ref) =>
      [ref.title, ref.cwd, harnessLabel(ref.harness)]
        .filter(Boolean)
        .some((field) => (field as string).toLowerCase().includes(needle))
    )
  }, [all, deferred])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-2">
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
            placeholder="Filter every agent's sessions"
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {shown.length === 0 ? (
          <p className="px-2 pt-6 text-center text-[11.5px] leading-relaxed text-faint">
            {loaded
              ? deferred
                ? "Nothing matches."
                : "No sessions found from any agent yet."
              : "Looking through every agent's sessions…"}
          </p>
        ) : (
          shown.map((ref) => <ThreadRow key={ref.path} threadRef={ref} />)
        )}
      </div>
    </div>
  )
}

const ThreadRow = memo(function ThreadRow({ threadRef: ref }: { threadRef: ThreadRef }) {
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  const working = useThreads((state) => Boolean(state.running[ref.path]))
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
        <span
          className={cn(
            "size-1.5 shrink-0 self-center rounded-full",
            harnessDot(ref.harness),
            working && "animate-pulse"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/85">
          {ref.title ?? "Untitled session"}
        </span>
        {working ? (
          <span className="shrink-0 text-[10.5px] text-faint">working…</span>
        ) : ref.updatedAt ? (
          <span className="tabular shrink-0 text-[10.5px] text-faint">
            {formatRelative(ref.updatedAt)}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-1.5 pl-3.5 text-[11px] text-faint">
        <span className="shrink-0">{harnessLabel(ref.harness)}</span>
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
