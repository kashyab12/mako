import { useCallback, useRef } from "react"
import { cn } from "@/lib/utils"

/**
 * A 1px hairline with a 9px grab area. Dragging writes straight to a ref-held
 * callback and never through React state, so a resize costs one style write
 * per frame instead of a tree render.
 */
export function Divider({
  side,
  size,
  min,
  max,
  onResize,
  onCommit,
  className,
}: {
  side: "left" | "right" | "bottom"
  size: number
  min: number
  max: number
  onResize: (next: number) => void
  onCommit: (next: number) => void
  className?: string
}) {
  const state = useRef<{
    start: number
    base: number
    latest: number
    frame: number | null
  }>({ start: 0, base: 0, latest: 0, frame: null })
  const horizontal = side === "bottom"

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture(event.pointerId)
      state.current = {
        start: horizontal ? event.clientY : event.clientX,
        base: size,
        latest: size,
        frame: null,
      }
      const cursor = document.body.style.cursor
      const userSelect = document.body.style.userSelect
      document.body.style.cursor = horizontal ? "row-resize" : "col-resize"
      document.body.style.userSelect = "none"

      const move = (moveEvent: PointerEvent) => {
        const point = horizontal ? moveEvent.clientY : moveEvent.clientX
        const delta = point - state.current.start
        const raw = state.current.base + (side === "left" ? delta : -delta)
        const next = Math.round(Math.min(max, Math.max(min, raw)))
        state.current.latest = next
        if (state.current.frame !== null) return
        state.current.frame = requestAnimationFrame(() => {
          state.current.frame = null
          onResize(state.current.latest)
        })
      }
      const finish = () => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", finish)
        handle.removeEventListener("pointercancel", finish)
        document.body.style.cursor = cursor
        document.body.style.userSelect = userSelect
        if (state.current.frame !== null) {
          cancelAnimationFrame(state.current.frame)
          state.current.frame = null
          onResize(state.current.latest)
        }
        onCommit(state.current.latest)
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", finish)
      handle.addEventListener("pointercancel", finish)
    },
    [horizontal, max, min, onCommit, onResize, side, size]
  )

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        onResize(min)
        onCommit(min)
      }}
      className={cn(
        "no-drag group relative z-10 shrink-0 bg-hairline",
        horizontal ? "h-px w-full cursor-row-resize" : "h-full w-px cursor-col-resize",
        className
      )}
    >
      <span
        className={cn(
          "absolute transition-colors duration-150 group-hover:bg-foreground/20 group-active:bg-foreground/35",
          horizontal ? "-top-1 -bottom-1 inset-x-0" : "inset-y-0 -left-1 -right-1"
        )}
      />
    </div>
  )
}
