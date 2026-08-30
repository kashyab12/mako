import { harnessLabel } from "@/components/rail/harness-meta"
import { ThreadRow } from "@/components/rail/thread-row"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { workspaceName } from "@/lib/format"
import { cn } from "@/lib/utils"
import { acp } from "@/state/acp"
import type { AcpPresence } from "@/state/acp-presence"
import type { ThreadRef } from "@/lib/types"

export function RunningThreads({
  refs,
  liveAgents,
}: {
  refs: ThreadRef[]
  liveAgents: AcpPresence[]
}) {
  const count = refs.length + liveAgents.length
  if (count === 0) return null
  return (
    <section aria-label="Running now" className="pt-1 pb-2">
      <h2 className="flex h-7 items-center px-1.5 text-label font-medium text-foreground/80">
        Running now
        <span className="ml-auto tabular text-faint">{count}</span>
      </h2>
      {liveAgents.map((presence) => (
        <LiveAgentRow key={presence.key} presence={presence} />
      ))}
      {refs.map((ref) => (
        <ThreadRow key={ref.path} threadRef={ref} showFolder />
      ))}
    </section>
  )
}

function LiveAgentRow({ presence }: { presence: AcpPresence }) {
  const label =
    presence.status === "needs-permission"
      ? "Needs input"
      : presence.status === "running"
        ? "Working"
        : presence.status === "starting"
          ? "Starting"
          : presence.status === "failed"
            ? "Failed"
            : "Ready"
  const title =
    presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
  return (
    <button
      type="button"
      aria-label={`${title}, ${label}`}
      data-thread-row
      onClick={() => acp.activate(presence.key)}
      className="group flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors duration-100 hover:bg-fill-hover"
    >
      <HarnessIcon harness={presence.harness} className="size-3 shrink-0 animate-live" />
      <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
        {title}
      </span>
      <span className="max-w-20 shrink-0 truncate text-label text-faint/70">
        {workspaceName(presence.cwd)}
      </span>
      <span
        className={cn(
          "shrink-0 text-label",
          presence.status === "needs-permission"
            ? "text-caution"
            : presence.status === "failed"
              ? "text-negative"
              : "text-faint"
        )}
      >
        {label}
      </span>
    </button>
  )
}
