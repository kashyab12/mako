import type { PendingPrompt } from "@/state/prompt-delivery"
import { updateAcpConversation } from "@/state/acp-state"
import { projectAcp } from "@/state/live-projection"

export function stagePrompt(id: string, prompt: PendingPrompt): void {
  updateAcpConversation(id, (current) => {
    if (current.pendingPrompts?.some((item) => item.id === prompt.id))
      return current
    const next = {
      ...current,
      pendingPrompts: [...(current.pendingPrompts ?? []), prompt],
    }
    return { ...next, projection: projectAcp(next) }
  })
}
export function removePendingPrompt(id: string, requestId: string): void {
  updateAcpConversation(id, (current) => {
    const next = {
      ...current,
      pendingPrompts: current.pendingPrompts?.filter(
        (item) => item.id !== requestId
      ),
    }
    return { ...next, projection: projectAcp(next) }
  })
}
