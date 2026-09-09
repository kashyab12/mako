import { memo, useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import type { Exchange } from "@/lib/exchanges"
import { promptLabel } from "@/lib/exchanges"

/** Width of the reserved gutter. The scroller pads by this, so nothing overlaps. */
export const NAVIGATOR_WIDTH = 26

/**
 * Below this the pane is too tight to give up a gutter, and the navigator
 * would be sitting on top of the prose instead of beside it.
 */
const MIN_PANE_WIDTH = 360

/**
 * The turn navigator.
 *
 * A tick per question, in a gutter the scroller reserves for it. It is the
 * fastest way to answer "where did I ask about X" in a long session: the whole
 * conversation is legible as a shape, hovering reads a question back without
 * moving the view, and clicking jumps to it.
 *
 * It occupies reserved space rather than floating over the transcript, and it
 * withdraws entirely on a narrow pane — a navigation aid that covers the thing
 * being navigated is worse than no aid at all.
 */
export const TurnNavigator = memo(function TurnNavigator({
  exchanges,
  activeId,
  onJump,
  paneRef,
}: {
  exchanges: Exchange[]
  activeId: string | null
  onJump: (id: string) => void
  /** The pane the navigator sits in, watched for available width. */
  paneRef: React.RefObject<HTMLElement | null>
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [wide, setWide] = useState(true)

  // The pane's width changes when either side panel opens, not only when the
  // window resizes — so observe the element rather than the viewport.
  useEffect(() => {
    const node = paneRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      setWide(entry.contentRect.width >= MIN_PANE_WIDTH)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [paneRef])

  // One or two turns is not a session worth navigating.
  if (exchanges.length < 3 || !wide) return null

  return (
    <nav
      aria-label="Previous prompts"
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
          setHovered(null)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false)
          setHovered(null)
        }
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false)
        setHovered(null)
      }}
      style={{ width: NAVIGATOR_WIDTH }}
      className="absolute top-[15%] right-0 bottom-[15%] z-10 flex items-center justify-end"
    >
      <div className="flex max-h-full flex-col gap-0.5 overflow-y-auto py-2 pr-2.5 [scrollbar-width:none]">
        {exchanges.map((exchange) => {
          const active = exchange.id === activeId
          const isHovered = exchange.id === hovered
          return (
            <button
              key={exchange.id}
              type="button"
              aria-label={promptLabel(exchange)}
              aria-current={active ? "true" : undefined}
              onMouseEnter={() => setHovered(exchange.id)}
              onClick={() => onJump(exchange.id)}
              className="pressable group/tick flex h-3 shrink-0 items-center justify-end focus-visible:outline focus-visible:outline-ring"
            >
              <span
                className={cn(
                  "block h-[2px] w-3.5 origin-right rounded-full",
                  // Width is the only channel doing work here: length reads as
                  // position without adding another colour to the window.
                  "[transition:transform_160ms_var(--ease-out),opacity_120ms_var(--ease-swift)] bg-foreground",
                  active
                    ? "scale-x-100 opacity-80"
                    : isHovered
                      ? "scale-x-100 opacity-60"
                      : open
                        ? "scale-x-75 opacity-40"
                        : "scale-x-50 opacity-30"
                )}
              />
            </button>
          )
        })}
      </div>

      {open ? (
        <Flyout exchanges={exchanges} activeId={hovered ?? activeId} onJump={onJump} onHover={setHovered} />
      ) : null}
    </nav>
  )
})

function Flyout({ exchanges, activeId, onJump, onHover }: {
  exchanges: Exchange[]
  activeId: string | null
  onJump(id: string): void
  onHover(id: string): void
}) {
  return (
    <div
      className={cn(
        // Opens inward, and is clamped so it can never reach past the
        // transcript's own column into the pane beside it.
        "absolute top-1/2 right-6 max-h-full w-[min(20rem,45vw)] -translate-y-1/2 overflow-y-auto",
        "overlay-panel rounded-lg bg-popover p-1.5"
      )}
    >
      <div className="px-2 py-1.5 text-label text-faint">{exchanges.length} prompts</div>
      {exchanges.map((exchange, index) => (
        <button
          key={exchange.id}
          type="button"
          onMouseEnter={() => onHover(exchange.id)}
          onFocus={() => onHover(exchange.id)}
          onClick={() => onJump(exchange.id)}
          aria-current={exchange.id === activeId ? "true" : undefined}
          className={cn("pressable flex w-full items-baseline gap-2 rounded px-2 py-2 text-left text-ui hover:bg-fill-hover focus-visible:outline focus-visible:outline-ring", exchange.id === activeId && "bg-fill-selected")}
        >
          <span aria-hidden className="tabular w-5 shrink-0 text-label text-faint">{index + 1}</span>
          <span className="line-clamp-2 min-w-0 leading-snug">{promptLabel(exchange)}</span>
        </button>
      ))}
    </div>
  )
}
