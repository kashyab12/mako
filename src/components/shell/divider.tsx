import { useCallback, useRef } from "react"
import { cn } from "@/lib/utils"

/**
 * A 1px hairline with a 9px grab area. Dragging writes straight to a ref-held
 * callback and never through React state, so a resize costs one style write
 * per frame instead of a tree render.
 */
export function Divider({
  side,
  width,
  min,
  max,
  onResize,
  onCommit,
  className,
}: {
  side: "left" | "right"
  width: number
  min: number
  max: number
  onResize: (next: number) => void
  onCommit: (next: number) => void
  className?: string
}) {
  const state = useRef({ start: 0, base: 0, latest: 0 })

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture(event.pointerId)
      state.current = { start: event.clientX, base: width, latest: width }
      document.body.style.cursor = "col-resize"

      const move = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - state.current.start
        const raw = state.current.base + (side === "left" ? delta : -delta)
        const next = Math.round(Math.min(max, Math.max(min, raw)))
        state.current.latest = next
        onResize(next)
      }
      const up = () => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", up)
        document.body.style.cursor = ""
        onCommit(state.current.latest)
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", up)
    },
    [max, min, onCommit, onResize, side, width]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        onResize(min)
        onCommit(min)
      }}
      className={cn(
        "no-drag group relative z-10 w-px shrink-0 cursor-col-resize bg-hairline",
        className
      )}
    >
      <span className="absolute inset-y-0 -left-1 -right-1 transition-colors duration-150 group-hover:bg-brand/35 group-active:bg-brand/60" />
    </div>
  )
}
