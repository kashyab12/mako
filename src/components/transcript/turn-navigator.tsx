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
const MIN_PANE_WIDTH = 620

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
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false)
        setHovered(null)
      }}
      style={{ width: NAVIGATOR_WIDTH }}
      className="absolute top-0 right-0 bottom-0 z-10 flex justify-end"
    >
      <div className="flex flex-col justify-center gap-[3px] py-6 pr-2.5">
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
              className="group/tick flex h-[7px] items-center justify-end"
            >
              <span
                className={cn(
                  "block h-[2px] rounded-full",
                  // Width is the only channel doing work here: length reads as
                  // position without adding another colour to the window.
                  "[transition:width_160ms_var(--ease-out),background-color_160ms_ease]",
                  active
                    ? "w-3.5 bg-foreground/80"
                    : isHovered
                      ? "w-3.5 bg-foreground/60"
                      : open
                        ? "w-2.5 bg-foreground/30"
                        : "w-1.5 bg-foreground/15"
                )}
              />
            </button>
          )
        })}
      </div>

      {hovered ? (
        <Flyout
          label={promptLabel(exchanges.find((exchange) => exchange.id === hovered)!)}
          index={exchanges.findIndex((exchange) => exchange.id === hovered) + 1}
          total={exchanges.length}
        />
      ) : null}
    </div>
  )
})

function Flyout({ label, index, total }: { label: string; index: number; total: number }) {
  return (
    <div
      className={cn(
        // Opens inward, and is clamped so it can never reach past the
        // transcript's own column into the pane beside it.
        "pointer-events-none absolute top-1/2 right-7 w-[min(20rem,45vw)] -translate-y-1/2",
        "animate-enter rounded-lg bg-popover px-2.5 py-1.5 ring-1 ring-border"
      )}
    >
      <div className="tabular text-label text-faint">
        Turn {index} of {total}
      </div>
      <div className="line-clamp-3 text-ui leading-snug text-foreground">{label}</div>
    </div>
  )
}
