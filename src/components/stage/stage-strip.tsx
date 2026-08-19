import { memo } from "react"
import { useSurfaces } from "@/extend/surfaces"
import { stage, useStage } from "@/state/stage"
import { useTabs } from "@/state/tabs"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"

/**
 * The stage strip: every registered surface of the current thread.
 *
 * This row replaced two older pieces of chrome at once — the inspector's tab
 * nav and the session tab strip. Horizontal tabs here mean *views of this
 * conversation*; the rail carries the conversations themselves, vertically.
 *
 * There is deliberately no "Chat" tab: the conversation is always on stage
 * and can never close, and a tab for a thing that cannot be left implies a
 * choice that does not exist. Each surface toggles — click opens it beside
 * the chat, click again puts it away — the same verb as its ⌘digit.
 *
 * It is a sibling of the stage, never its parent: a badge repaint or a
 * registry bump must not touch the cards.
 */
export function StageStrip() {
  const surfaces = useSurfaces()
  const activeId = useTabs((state) => state.activeId)
  const companion = useStage((state) => state.byTab[activeId]?.companion ?? null)

  return (
    <nav className="flex h-9 shrink-0 items-center gap-0.5 px-2 pt-1.5">
      {surfaces.map((surface) => {
        const Icon = surface.icon
        const on = companion === surface.id
        return (
          <StripTab
            key={surface.id}
            active={on}
            icon={Icon ? <Icon className="size-3.5" /> : null}
            label={surface.label}
            onActivate={() => stage.toggle(surface.id)}
            badge={surface.id === "changes" ? <ChangesBadge /> : null}
          />
        )
      })}
    </nav>
  )
}

function StripTab({
  active,
  icon,
  label,
  badge,
  onActivate,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  badge?: React.ReactNode
  onActivate: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      // Mousedown, not click: switching a view should not wait out the
      // press-release gap. Keyboard activation arrives with detail 0 and
      // takes the click path instead.
      onMouseDown={(event) => {
        if (event.button === 0 && event.detail > 0) onActivate()
      }}
      onClick={(event) => {
        if (event.detail === 0) onActivate()
      }}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-ui font-medium transition-colors duration-100",
        active ? "bg-fill-selected text-foreground" : "text-faint hover:bg-fill-hover hover:text-muted-foreground"
      )}
    >
      {icon}
      {label}
      {badge}
    </button>
  )
}

/** A leaf on purpose: a git flush repaints this span and nothing else. */
const ChangesBadge = memo(function ChangesBadge() {
  const count = useSession((state) => state.git?.files.length ?? 0)
  if (count === 0) return null
  return (
    <span className="tabular rounded bg-caution/15 px-1 text-label text-caution">{count}</span>
  )
})
