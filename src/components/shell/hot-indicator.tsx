import { useEffect, useState } from "react"
import { consumeFullReload, onHotUpdate, type HotUpdate } from "@/desk/hot-reload"
import { cn } from "@/lib/utils"
import { RotateCcwIcon, ZapIcon, SquareArrowOutUpRightIcon } from "lucide-react"
import { manualReload, interfacePreview, openInterfacePreview, reloadInterface } from "@/state/development"

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
    if (!update || update.kind === "available") return
    const timer = setTimeout(() => setUpdate(null), 2400)
    return () => clearTimeout(timer)
  }, [update])

  useEffect(() => {
    if (!reloaded) return
    const timer = setTimeout(() => setReloaded(false), 4000)
    return () => clearTimeout(timer)
  }, [reloaded])

  if (manualReload || !import.meta.env.DEV) {
    return (
      <div className="no-drag flex shrink-0 items-center gap-1 text-label">
        {manualReload || interfacePreview ? <span title={interfacePreview ? "This window shares agents and conversations with the Mako host that opened it." : "This dev build has a separate host from installed Mako. Open a shared preview to compare interfaces with the same live chats."} className="border border-hairline px-1.5 py-0.5 text-muted-foreground">{interfacePreview ? "Shared preview" : "Isolated dev"}</span> : null}
        <button type="button" onClick={reloadInterface} title="Load the latest interface without stopping agents. Host changes need Restart Mako." className="pressable flex h-6 items-center gap-1 rounded px-1.5 hover:bg-fill-hover hover:text-foreground">
          <RotateCcwIcon className="size-3" />
          {update?.kind === "available" ? "Reload UI · changes ready" : "Reload UI"}
        </button>
        <button type="button" onClick={openInterfacePreview} aria-label="Open shared-host preview" title="Share live chats with this Mako host. Separate dev builds do not sync live conversations." className="pressable flex size-6 items-center justify-center rounded hover:bg-fill-hover hover:text-foreground">
          <SquareArrowOutUpRightIcon className="size-3" />
        </button>
      </div>
    )
  }

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
