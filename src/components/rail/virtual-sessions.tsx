import { memo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Slot } from "@/extend/slot"
import { firstLine, formatRelative, workspaceName } from "@/lib/format"
import { togglePinned, usePrefs } from "@/state/prefs"
import { PinIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { toggleGroupCollapsed } from "@/state/prefs"
import type { RailRow } from "@/components/rail/rail-rows"
import type { SessionSummary } from "@/lib/types"
import { ChevronRightIcon } from "lucide-react"

export const ROW_HEIGHT = 44
export const HEADER_HEIGHT = 26

/**
 * The virtualized body of the session rail.
 *
 * It lives in its own component for a specific reason: `useVirtualizer`
 * returns functions the React Compiler cannot safely memoize, so it bails out
 * of optimizing whatever component calls it. Isolating the call keeps that
 * bail-out to this subtree and leaves the rail's header, search, and empty
 * states fully compiled.
 */
export function VirtualSessions({
  rows,
  activePath,
  showProject,
  onOpen,
}: {
  rows: RailRow[]
  activePath?: string
  /** Label each row with its project — only useful when scope spans projects. */
  showProject: boolean
  onOpen: (path: string, options?: { inNewTab?: boolean }) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (rows[index].kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 8,
    getItemKey: (index) => rows[index].key,
  })

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          return (
            <div
              key={item.key}
              // translate3d keeps each row on the compositor, so scrolling
              // costs a paint rather than a layout pass.
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: item.size,
                transform: `translate3d(0, ${item.start}px, 0)`,
              }}
            >
              {row.kind === "header" ? (
                <GroupHeader row={row} />
              ) : (
                <RailRowItem
                  session={row.session}
                  active={row.session.path === activePath}
                  showProject={showProject}
                  onOpen={onOpen}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const GroupHeader = memo(function GroupHeader({
  row,
}: {
  row: Extract<RailRow, { kind: "header" }>
}) {
  const collapsible = row.key !== "results"

  return (
    <button
      type="button"
      disabled={!collapsible}
      onClick={() => toggleGroupCollapsed(row.key)}
      className={cn(
        "group/header flex h-full w-full items-center gap-1 rounded px-1 text-left",
        collapsible && "hover:bg-raised/60"
      )}
    >
      {collapsible ? (
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-faint transition-transform duration-150",
            !row.collapsed && "rotate-90"
          )}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-faint">{row.label}</span>
      <span className="tabular shrink-0 pr-1 text-[10px] text-faint/70">{row.count}</span>
    </button>
  )
})

const RailRowItem = memo(function RailRowItem({
  session,
  active,
  showProject,
  onOpen,
}: {
  session: SessionSummary
  active: boolean
  showProject: boolean
  onOpen: (path: string, options?: { inNewTab?: boolean }) => void
}) {
  const title = session.name || firstLine(session.firstMessage, 60) || "Untitled session"
  const detail = session.name ? firstLine(session.firstMessage, 60) : `${session.messageCount} messages`
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(session.path))

  return (
    <button
      type="button"
      // Modifier-click opens beside instead of replacing — the same bargain
      // every browser and editor makes, so it needs no explaining.
      onClick={(event) =>
        onOpen(session.path, { inNewTab: event.metaKey || event.ctrlKey || event.shiftKey })
      }
      onAuxClick={(event) => {
        if (event.button === 1) onOpen(session.path, { inNewTab: true })
      }}
      data-active={active || undefined}
      title={`${session.cwd}\n⌘-click to open in a new tab`}
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
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12.5px]",
            active ? "font-medium text-foreground" : "text-foreground/85"
          )}
        >
          {title}
        </span>
        <span
          role="button"
          tabIndex={-1}
          aria-label={isPinned ? "Unpin" : "Pin"}
          onClick={(event) => {
            event.stopPropagation()
            togglePinned(session.path)
          }}
          className={cn(
            "shrink-0 rounded p-0.5 transition-opacity",
            isPinned
              ? "text-foreground/70"
              : "text-faint opacity-0 group-hover:opacity-100 hover:text-foreground"
          )}
        >
          <PinIcon className={cn("size-3", isPinned && "fill-current")} />
        </span>
        <span className="tabular shrink-0 text-[10.5px] text-faint">
          {formatRelative(session.modified)}
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-faint">
        {showProject ? (
          <span className="shrink-0 rounded bg-raised px-1 text-[10px] text-muted-foreground">
            {workspaceName(session.cwd)}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{detail}</span>
        <Slot name="rail.session.trailing" session={session} active={active} />
      </span>
    </button>
  )
})
