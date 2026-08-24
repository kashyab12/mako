import { useEffect, useRef } from "react"
import { formatRelative } from "@/lib/format"
import type { ThreadStatus } from "@/state/threads"
import {
  CheckIcon,
  Loader2Icon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
} from "lucide-react"

export function ThreadStatusMark({
  status,
  updatedAt,
}: {
  status: ThreadStatus
  updatedAt?: string
}) {
  switch (status.kind) {
    case "working":
      return (
        <span
          title={status.detail ?? "Working in Mako"}
          className="flex shrink-0 items-center gap-1 text-label text-ember/80"
        >
          <Loader2Icon className="size-3 animate-spin" />
          <Elapsed since={status.since} />
        </span>
      )
    case "needs-permission":
      return (
        <ShieldQuestionIcon
          className="size-3 shrink-0 text-caution"
          aria-label={
            status.detail ? `Needs input: ${status.detail}` : "Needs input"
          }
        />
      )
    case "failed":
      return (
        <TriangleAlertIcon
          className="size-3 shrink-0 text-negative"
          aria-label={status.detail ? `Failed: ${status.detail}` : "Failed"}
        />
      )
    case "review":
      return (
        <span
          className="relative flex size-3 shrink-0 items-center justify-center"
          aria-label="Ready for review"
        >
          <CheckIcon className="size-3 text-positive" />
          {status.unread ? (
            <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground" />
          ) : null}
        </span>
      )
    case "observed":
    case "external-active":
      return (
        <Loader2Icon
          className="size-3 shrink-0 animate-spin text-foreground/45"
          aria-label={
            status.kind === "external-active"
              ? "Active in another app"
              : "Live activity"
          }
        />
      )
    case "external-open":
    case "idle":
      return updatedAt ? (
        <span className="tabular shrink-0 text-label text-faint">
          {formatRelative(updatedAt)}
        </span>
      ) : null
  }
}

function Elapsed({ since }: { since: number }) {
  const element = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const update = () => {
      if (element.current)
        element.current.textContent = formatElapsed(Date.now() - since)
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return <span ref={element} className="tabular" />
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}
