import { useState } from "react"
import { AgentPicker } from "@/components/composer/agent-picker"
import { ForeignEffortPicker } from "@/components/composer/foreign-effort"
import { ForeignModelPicker } from "@/components/composer/foreign-model"
import { harnessTitle } from "@/components/composer/harness-title"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { acp, activeAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"

const EMPTY_QUEUE: never[] = []

/**
 * The left half of the toolbar, routed like the box above it.
 *
 * An open foreign conversation locks the composer to its harness — the mark
 * and name say so, and the run's state rides beside them. Otherwise the
 * provider picker chooses who answers next; model options come directly
 * from that provider's runtime catalog.
 */
export function ComposerRouting() {
  const viewing = useThreads((state) => state.viewing?.ref)
  const viewingQueued = useThreads((state) =>
    state.viewing
      ? (state.queuedReplies[state.viewing.ref.path]?.prompts.length ?? 0)
      : 0
  )
  const harness = useThreads((state) => state.composerHarness)
  const activeHarness = useAcp((state) => activeAcp(state)?.harness)
  const activeKind = useAcp((state) => activeAcp(state)?.kind)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const queued = useAcp((state) => activeAcp(state)?.queued ?? EMPTY_QUEUE)
  const [modelChangedFor, setModelChangedFor] = useState<string | null>(null)
  const moving = Boolean(viewing && harness !== viewing.harness)
  const modelContext = `${viewing?.path ?? "new"}:${harness}`
  const threadModel =
    !moving && modelChangedFor !== modelContext ? viewing?.model : undefined

  if (activeHarness && (!viewing || viewing.path === liveThreadPath)) {
    return (
      <span className="flex h-7 items-center gap-1.5 rounded-md bg-raised px-2 text-ui text-foreground/85">
        <HarnessIcon harness={activeHarness} className="size-3.5" />
        {harnessTitle(activeHarness)}
        <span className="text-label text-faint">
          {activeKind === "starting" ? "starting" : "live"}
        </span>
        {queued.length > 0 ? (
          <button
            type="button"
            onClick={() => acp.unqueue()}
            className="pressable rounded px-1 text-label text-faint hover:text-foreground"
          >
            {queued.length} queued · clear
          </button>
        ) : null}
      </span>
    )
  }

  return (
    <>
      <AgentPicker />
      <ForeignModelPicker
        harness={harness}
        threadModel={threadModel}
        onChange={() => setModelChangedFor(modelContext)}
      />
      <ForeignEffortPicker harness={harness} threadModel={threadModel} />
      {viewingQueued > 0 ? (
        <span className="flex h-7 items-center rounded-md bg-raised px-2 text-label text-faint">
          {viewingQueued} queued
        </span>
      ) : null}
      {moving ? (
        <span className="animate-enter flex h-7 items-center gap-1 rounded-md bg-fill-selected px-2 text-label font-medium text-foreground">
          moves here on send
        </span>
      ) : null}
    </>
  )
}
