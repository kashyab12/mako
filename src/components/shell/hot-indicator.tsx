import { useEffect, useState } from "react"
import { consumeFullReload, onHotUpdate, type HotUpdate } from "@/desk/hot-reload"
import { cn } from "@/lib/utils"
import { RotateCcwIcon, ZapIcon } from "lucide-react"

/**
 * Says when Mako has just rewritten itself.
 *
 * The whole reason to edit this app from inside itself is that the change
 * lands without a restart — but a silent swap is indistinguishable from an
 * edit that did nothing. This is the confirmation: what changed, and that it
 * is already running.
 *
 * It withdraws after a couple of seconds. This is feedback, not status; a
 * permanent badge would be reporting the same fact forever.
 */
export function HotIndicator() {
  const [update, setUpdate] = useState<HotUpdate | null>(null)
  const [reloaded, setReloaded] = useState(consumeFullReload)

  useEffect(() => onHotUpdate(setUpdate), [])

  useEffect(() => {
    if (!update) return
    const timer = setTimeout(() => setUpdate(null), 2400)
    return () => clearTimeout(timer)
  }, [update])

  useEffect(() => {
    if (!reloaded) return
    const timer = setTimeout(() => setReloaded(false), 4000)
    return () => clearTimeout(timer)
  }, [reloaded])

  if (reloaded) {
    return (
      <Pill tone="caution" icon={<RotateCcwIcon className="size-3" />}>
        Reloaded — Fast Refresh could not swap that in place
      </Pill>
    )
  }

  if (!update) return null

  const [first, ...rest] = update.files
  const label = rest.length > 0 ? `${short(first)} +${rest.length}` : short(first)

  return (
    <Pill
      // Keyed on the timestamp so a second edit to the same file replays the
      // animation instead of sitting there looking stale.
      key={update.at}
      icon={<ZapIcon className="size-3" />}
    >
      {label}
    </Pill>
  )
}

function Pill({
  children,
  icon,
  tone,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  tone?: "caution"
}) {
  return (
    <span
      className={cn(
        "animate-enter flex min-w-0 items-center gap-1.5 rounded-full px-2 py-px",
        "text-label whitespace-nowrap",
        tone === "caution" ? "bg-caution/12 text-caution" : "bg-fill-selected text-muted-foreground"
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** `src/components/rail/session-rail.tsx` reads as `rail/session-rail.tsx`. */
function short(path: string) {
  return path.replace(/^src\//, "").replace(/^components\//, "")
}
