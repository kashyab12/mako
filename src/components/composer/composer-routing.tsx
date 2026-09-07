import { useState } from "react"
import { AgentPicker } from "@/components/composer/agent-picker"
import { ForeignEffortPicker } from "@/components/composer/foreign-effort"
import { ForeignModelPicker } from "@/components/composer/foreign-model"
import { acp, activeAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"

const EMPTY_QUEUE: never[] = []

/** The selected provider answers the next turn in the current conversation. */
export function ComposerRouting() {
  const viewing = useThreads((state) => state.viewing?.ref)
  const viewingQueued = useThreads((state) =>
    state.viewing
      ? state.nativeRequests.filter(
          (request) =>
            request.input.path === state.viewing?.ref.path &&
            request.status === "queued"
        ).length
      : 0
  )
  const harness = useThreads((state) => state.composerHarness)
  const activeHarness = useAcp((state) => activeAcp(state)?.harness)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const queued = useAcp((state) => activeAcp(state)?.queued ?? EMPTY_QUEUE)
  const [modelChangedFor, setModelChangedFor] = useState<string | null>(null)
  const liveOwnsComposer = Boolean(
    activeHarness && (!viewing || viewing.path === liveThreadPath)
  )
  const sourceHarness = liveOwnsComposer ? activeHarness : viewing?.harness
  const moving = Boolean(sourceHarness && harness !== sourceHarness)
  const modelContext = `${viewing?.path ?? "new"}:${harness}`
  const threadModel =
    !moving && modelChangedFor !== modelContext ? viewing?.model : undefined

  return (
    <>
      <AgentPicker />
      <ForeignModelPicker
        harness={harness}
        threadModel={threadModel}
        onChange={() => setModelChangedFor(modelContext)}
      />
      <ForeignEffortPicker harness={harness} threadModel={threadModel} />
      {liveOwnsComposer && queued.length > 0 ? (
        <button
          type="button"
          className="pressable px-1 text-label text-faint"
          onClick={() => acp.unqueue()}
        >
          {queued.length} queued · clear
        </button>
      ) : null}
      {viewingQueued > 0 ? (
        <span className="flex h-7 items-center rounded-md bg-raised px-2 text-label text-faint">
          {viewingQueued} queued
        </span>
      ) : null}
      {moving ? (
        <span className="animate-enter flex h-7 items-center gap-1 rounded-md bg-fill-selected px-2 text-label font-medium text-foreground">
          continues here on send
        </span>
      ) : null}
    </>
  )
}
