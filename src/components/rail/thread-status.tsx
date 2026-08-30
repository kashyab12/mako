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
          <span>Working</span>
          <Elapsed since={status.since} />
        </span>
      )
    case "needs-permission":
      return (
        <span
          title={status.detail ?? "Needs input"}
          className="flex shrink-0 items-center gap-1 text-label text-caution"
        >
          <ShieldQuestionIcon className="size-3" />
          Needs input
        </span>
      )
    case "failed":
      return (
        <span
          title={status.detail ?? "Failed"}
          className="flex shrink-0 items-center gap-1 text-label text-negative"
        >
          <TriangleAlertIcon className="size-3" />
          Failed
        </span>
      )
    case "review":
      return (
        <span className="flex shrink-0 items-center gap-1 text-label text-positive">
          <CheckIcon className="size-3" />
          {status.unread ? "Done" : "Reviewed"}
        </span>
      )
    case "observed":
    case "external-active":
      return (
        <span
          title={
            status.kind === "external-active"
              ? "Active in another app"
              : "Live activity"
          }
          className="flex shrink-0 items-center gap-1 text-label text-faint"
        >
          <Loader2Icon className="size-3 animate-spin" />
          Active
        </span>
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
