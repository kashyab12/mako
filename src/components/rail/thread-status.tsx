import { formatRelative } from "@/lib/format"
import type { ThreadStatus } from "@/state/threads"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"

export function ThreadStatusMark({
  status,
  updatedAt,
}: {
  status: ThreadStatus
  updatedAt?: string
}) {
  if (status.kind === "idle")
    return updatedAt ? (
      <span className="tabular shrink-0 text-label text-faint">
        {formatRelative(updatedAt)}
      </span>
    ) : null
  if (status.kind === "external-open" || status.kind === "observed")
    return (
      <span
        title={
          status.kind === "external-open"
            ? "Open in another app; no running turn reported"
            : "The session changed; running state is unconfirmed"
        }
        className="shrink-0 text-label text-faint"
      >
        {status.kind === "external-open" ? "Open" : "Updated"}
      </span>
    )
  const state: ActivityState =
    status.kind === "failed"
      ? "failed"
      : status.kind === "needs-permission"
        ? "waiting"
        : status.kind === "review"
          ? "complete"
          : "working"
  const label =
    status.kind === "working"
      ? (status.detail ?? "Working in Mako")
      : status.kind === "external-active"
        ? "Working in another app"
        : status.kind === "failed"
          ? (status.detail ?? "Failed")
          : status.kind === "needs-permission"
            ? (status.detail ?? "Needs your approval")
            : status.unread
              ? "Answer ready to review"
              : "Reviewed"
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="flex shrink-0 items-center text-muted-foreground"
    >
      <ActivityMark state={state} size={20} />
    </span>
  )
}
