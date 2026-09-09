import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { workspaceName } from "@/lib/format"
import { acp } from "@/state/acp"
import type { AcpPresence } from "@/state/acp-presence"
import { cn } from "@/lib/utils"

export function LiveAgentRow({
  presence,
  indent = false,
}: {
  presence: AcpPresence
  indent?: boolean
}) {
  const label =
    presence.status === "needs-permission"
      ? "Needs your approval"
      : presence.status === "running"
        ? "Working"
        : presence.status === "starting"
          ? "Connecting"
          : presence.status === "failed"
            ? "Failed"
            : "Ready"
  const state: ActivityState =
    presence.status === "needs-permission"
      ? "waiting"
      : presence.status === "starting"
        ? "connecting"
        : presence.status === "running"
          ? "working"
          : presence.status === "failed"
            ? "failed"
            : "idle"
  const title =
    presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
  return (
    <button
      type="button"
      aria-label={`${title}, ${label}`}
      data-thread-row
      data-thread-indent={indent || undefined}
      onClick={() => acp.activate(presence.key)}
      className={cn(
        "pressable group flex h-7 w-full items-center gap-2 rounded-md pr-1.5 text-left transition-colors duration-100 hover:bg-fill-hover",
        indent ? "pl-[26px]" : "pl-1.5"
      )}
    >
      <HarnessIcon harness={presence.harness} className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
        {title}
      </span>
      {!indent ? (
        <span className="max-w-20 shrink-0 truncate text-label text-faint">
          {workspaceName(presence.cwd)}
        </span>
      ) : null}
      <span title={label} className="flex shrink-0 text-muted-foreground">
        <ActivityMark state={state} size={20} />
      </span>
    </button>
  )
}
