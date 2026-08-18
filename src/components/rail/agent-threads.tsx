import { memo, useDeferredValue, useMemo, useState } from "react"
import { bucketFor, formatRelative, workspaceName } from "@/lib/format"
import { threads, useThreads } from "@/state/threads"
import { actions, useSession } from "@/state/session"
import { setPref, togglePinned, usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ChevronRightIcon, PinIcon, SearchIcon, XIcon } from "lucide-react"
import type { Harness, ThreadRef } from "@/lib/types"

/**
 * The threads rail: every agent's conversations, one list.
 *
 * There used to be two lists — this app's own sessions under "Threads" and
 * everyone else's under "Agents" — which was the architecture showing
 * through. Nobody thinks of their conversations by which binary wrote the
 * file; they think of *this project's threads*. So: one list, scoped to the
 * project by default, every harness in it, each row wearing its mark. Pi
 * rows open natively in a tab; other harnesses open in the viewer, from
 * which the conversation goes anywhere.
 *
 * Scope is a single toggle: this project, or everywhere. Opening a different
 * project changes what "this project" means and the list follows — nothing
 * is imported, because nothing was ever anywhere else.
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

const BUCKET_ORDER = ["Pinned", "Today", "Yesterday", "This week", "This month", "Earlier"]

export function AgentThreads() {
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query)
  const all = useThreads((state) => state.threads)
  const loaded = useThreads((state) => state.loaded)
  const filter = usePrefs((prefs) => prefs.agentHarnessFilter)
  const pinned = usePrefs((prefs) => prefs.pinnedThreads)
  const scope = usePrefs((prefs) => prefs.railScope)
  const collapsed = usePrefs((prefs) => prefs.collapsedGroups)
  const cwd = useSession((state) => state.meta?.cwd)

  // The haystack is built once per catalog push, not once per keystroke —
  // lowering six hundred titles on every character is the difference between
  // instant and merely fast.
  const indexed = useMemo(
    () =>
      all.map((ref) => ({
        ref,
        haystack:
          `${ref.title ?? ""} ${ref.cwd ?? ""} ${harnessLabel(ref.harness)} ${ref.model ?? ""}`.toLowerCase(),
      })),
    [all]
  )

  const scoped = useMemo(
    () =>
      scope === "workspace" && cwd ? indexed.filter((entry) => entry.ref.cwd === cwd) : indexed,
    [cwd, indexed, scope]
  )

  const counts = useMemo(() => {
    const byHarness = new Map<string, number>()
    for (const entry of scoped) {
      byHarness.set(entry.ref.harness, (byHarness.get(entry.ref.harness) ?? 0) + 1)
    }
    return byHarness
  }, [scoped])

  const groups = useMemo(() => {
    const needle = deferred.trim().toLowerCase()
    const active = filter.length > 0 ? new Set(filter) : null
    const matched = scoped
      .filter(
        (entry) =>
          (!active || active.has(entry.ref.harness)) &&
          (!needle || entry.haystack.includes(needle))
      )
      .map((entry) => entry.ref)

    if (needle) {
      return {
        total: matched.length,
        sections: [
          [`${matched.length} match${matched.length === 1 ? "" : "es"}`, matched] as const,
        ],
      }
    }

    const set = new Set(pinned)
    const held = matched.filter((ref) => set.has(ref.path))
    held.sort((a, b) => pinned.indexOf(a.path) - pinned.indexOf(b.path))
    const rest = matched.filter((ref) => !set.has(ref.path))

    const byBucket = new Map<string, ThreadRef[]>()
    if (held.length > 0) byBucket.set("Pinned", held)
    for (const ref of rest) {
      const label = ref.updatedAt ? bucketFor(ref.updatedAt) : "Earlier"
      const list = byBucket.get(label)
      if (list) list.push(ref)
      else byBucket.set(label, [ref])
    }
    const sections = [...byBucket.entries()].sort((a, b) => orderOf(a[0]) - orderOf(b[0]))
    return { total: matched.length, sections }
  }, [deferred, filter, pinned, scoped])

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
            placeholder={scope === "workspace" ? "Search this project's threads" : "Search every thread"}
            className="h-7 w-full rounded-md bg-surface pr-6 pl-7 text-[11.5px] text-foreground placeholder:text-faint transition-shadow duration-150 focus:ring-1 focus:ring-hairline focus:outline-none"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-faint hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
        <ScopeToggle scope={scope} />
      </div>

      {/* One chip per harness with sessions in scope, with its count.
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
                  "pressable flex h-6 items-center gap-1.5 rounded-full border px-2 text-[10.5px] transition-colors duration-150",
                  on
                    ? "border-foreground/40 bg-raised text-foreground"
                    : "border-hairline text-faint hover:border-foreground/20 hover:text-muted-foreground"
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
        {groups.total === 0 ? (
          <p className="px-2 pt-6 text-center text-[11.5px] leading-relaxed text-faint">
            {loaded
              ? deferred || filter.length > 0
                ? "Nothing matches."
                : scope === "workspace"
                  ? "No threads in this project yet — from any agent."
                  : "No sessions found from any agent yet."
              : "Looking through every agent's sessions…"}
          </p>
        ) : (
          groups.sections.map(([label, refs]) => (
            <Group
              key={label}
              label={label}
              refs={refs}
              collapsible={!deferred.trim()}
              collapsed={collapsed.includes(`agents:${label}`)}
              onToggle={() => {
                const key = `agents:${label}`
                setPref(
                  "collapsedGroups",
                  collapsed.includes(key)
                    ? collapsed.filter((entry) => entry !== key)
                    : [...collapsed, key]
                )
              }}
            />
          ))
        )}
      </div>
    </div>
  )
}

function orderOf(label: string): number {
  const at = BUCKET_ORDER.indexOf(label)
  return at === -1 ? BUCKET_ORDER.length : at
}

/** This project, or everywhere. One word each; the rail is narrow. */
function ScopeToggle({ scope }: { scope: "workspace" | "all" }) {
  return (
    <div className="flex h-7 shrink-0 items-center rounded-md bg-surface p-0.5">
      {(
        [
          ["workspace", "Project"],
          ["all", "All"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setPref("railScope", value)}
          className={cn(
            "rounded-[5px] px-1.5 text-[10.5px] transition-colors duration-150",
            scope === value
              ? "bg-raised text-foreground"
              : "text-faint hover:text-muted-foreground"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * A date group that opens and closes smoothly.
 *
 * The collapse animates through CSS grid rows — 1fr to 0fr — which is the
 * one way to animate to an unknown height without measuring it. 200ms
 * ease-out, because this happens at the user's hand and should answer
 * instantly.
 */
function Group({
  label,
  refs,
  collapsible,
  collapsed,
  onToggle,
}: {
  label: string
  refs: readonly ThreadRef[]
  collapsible: boolean
  collapsed: boolean
  onToggle: () => void
}) {
  const down = collapsible && collapsed
  return (
    <div className="pb-0.5">
      <button
        type="button"
        onClick={collapsible ? onToggle : undefined}
        className="sticky top-0 z-10 flex w-full items-center gap-1 rounded-sm bg-background/85 px-1.5 py-1.5 backdrop-blur-sm"
      >
        {collapsible ? (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-faint/70 transition-transform duration-200 ease-out",
              !down && "rotate-90"
            )}
          />
        ) : null}
        <span className="text-[10.5px] font-medium tracking-wide text-faint">{label}</span>
        <span className="tabular ml-auto pr-1 text-[10px] text-faint/60">{refs.length}</span>
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          down ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {refs.map((ref) => (
            <ThreadRow key={ref.path} threadRef={ref} />
          ))}
        </div>
      </div>
    </div>
  )
}

const ThreadRow = memo(function ThreadRow({ threadRef: ref }: { threadRef: ThreadRef }) {
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  const working = useThreads((state) => Boolean(state.running[ref.path]))
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(ref.path))
  const active = useSession((state) => state.meta?.sessionFile === ref.path)
  const scope = usePrefs((prefs) => prefs.railScope)

  const open = (inNewTab: boolean) => {
    // Pi sessions are this app's own: open them natively, with full fidelity
    // and a live agent. Everything else opens translated, read-only, with
    // every continuation one click away.
    if (ref.harness === "pi") void actions.openSession(ref.path, { inNewTab })
    else void threads.view(ref)
  }

  return (
    <button
      type="button"
      onClick={(event) => open(event.metaKey || event.ctrlKey || event.shiftKey)}
      onAuxClick={(event) => {
        if (event.button === 1) open(true)
      }}
      title={ref.cwd ? `${ref.cwd}\n⌘-click to open in a new tab` : undefined}
      data-active={active || undefined}
      className={cn(
        "group relative flex h-[42px] w-full flex-col justify-center gap-0.5 rounded-md px-2 text-left",
        "transition-colors duration-100 hover:bg-raised data-active:bg-raised"
      )}
    >
      <span
        className={cn(
          "absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-foreground transition-opacity duration-150",
          active ? "opacity-70" : "opacity-0"
        )}
      />
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
          <HarnessIcon harness={ref.harness} className={cn("size-3", working && "animate-pulse")} />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12.5px]",
            active ? "font-medium text-foreground" : "text-foreground/85"
          )}
        >
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
            "shrink-0 self-center rounded p-0.5 transition-opacity duration-150",
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
        {scope === "all" && ref.cwd ? (
          <>
            <span className="text-faint/50">·</span>
            <span className="min-w-0 truncate">{workspaceName(ref.cwd)}</span>
          </>
        ) : ref.model ? (
          <>
            <span className="text-faint/50">·</span>
            <span className="min-w-0 truncate">{ref.model}</span>
          </>
        ) : null}
      </span>
    </button>
  )
})
