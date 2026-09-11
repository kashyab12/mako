import { formatRelative } from "@/lib/format"
import { harnessLabel } from "@/components/rail/harness-meta"
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
  // Open elsewhere: the time stays, and a hollow ring says a window is on it.
  // The app is named where a label would not fit.
  if (status.kind === "external-open") {
    const label = `Open in ${harnessLabel(status.app)}; no running turn reported`
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className="flex shrink-0 items-center gap-1.5 text-label text-faint"
      >
        <span aria-hidden className="size-1.5 rounded-full ring-1 ring-current" />
        {updatedAt ? <span className="tabular">{formatRelative(updatedAt)}</span> : null}
      </span>
    )
  }
  if (status.kind === "observed")
    return (
      <span
        title="The session changed; running state is unconfirmed"
        className="shrink-0 text-label text-faint"
      >
        Updated
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
