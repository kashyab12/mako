import { AgentThreads } from "@/components/rail/agent-threads"
import { Slot } from "@/extend/slot"

/**
 * The session rail is the conversations — one list for every harness,
 * folder-arranged. The project's files moved to the inspector, beside
 * Changes and History, where the focused project's tree belongs; a rail
 * that answers two different questions needs a mode switch, and a mode
 * switch is a question of its own.
 */
export function SessionRail() {
  return (
    <aside className="flex h-full min-h-0 flex-col">
      <AgentThreads />
      <Slot name="rail.footer" />
    </aside>
  )
}
