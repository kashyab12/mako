import { canResumeInteractively } from "@/state/thread-tuning"
import { getMako, hasBridge } from "@/lib/bridge"
import type { PromptAttachment } from "@/lib/types"
import {
  acpStore,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import { toast } from "sonner"

function updateLive(
  id: string,
  update: (conversation: LiveAcpConversation) => LiveAcpConversation
): LiveAcpConversation | null {
  const next = updateAcpConversation(id, (conversation) =>
    conversation.kind === "live" ? update(conversation) : conversation
  )
  return next?.kind === "live" ? next : null
}

export async function sendTo(
  id: string,
  text: string,
  attachments: PromptAttachment[] = []
): Promise<boolean> {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live" || !hasBridge()) return false
  if (current.session.connection === "disconnected") {
    const ref = current.threadPath
      ? await getMako().openThread(current.threadPath)
      : null
    if (!ref) {
      toast.error(
        "The native session is unavailable; the saved capture remains readable"
      )
      return false
    }
    if (!canResumeInteractively(ref.ref.harness))
      return (
        await import("@/state/thread-continuation")
      ).threadContinuationActions.moveAndSend(
        ref.ref,
        ref.ref.harness,
        text,
        attachments
      )
    return (await import("@/state/acp")).acp.resumeAndSend(
      ref.ref,
      text,
      attachments
    )
  }
  const requestId = crypto.randomUUID()
  updateLive(id, (conversation) => ({
    ...conversation,
    sending: true,
    updatedAt: Date.now(),
  }))
  try {
    await getMako().livePrompt(id, requestId, text, attachments)
    return true
  } catch (error) {
    const snapshot = await getMako()
      .liveSnapshot(id)
      .catch(() => null)
    if (snapshot?.requests.some((request) => request.id === requestId))
      return true
    updateLive(id, (conversation) => ({
      ...conversation,
      sending: false,
      updatedAt: Date.now(),
    }))
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}
