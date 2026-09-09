import type { PendingPrompt } from "@/state/prompt-delivery"
import type { QueuedPromptEdit } from "../../electron/contracts/live-queue"
import { threadsStore } from "@/state/thread-store"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { stagePrompt, removePendingPrompt } from "@/state/acp-pending"
import { liveSettingsTarget, settingsForSend } from "@/state/composer-settings"
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
  attachments: PromptAttachment[] = [],
  requestId = crypto.randomUUID()
): Promise<boolean> {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live" || !hasBridge()) return false
  stagePrompt(id, { id: requestId, text, attachments })
  updateLive(id, (conversation) => ({
    ...conversation,
    sending: true,
    updatedAt: Date.now(),
  }))
  try {
    await getMako().livePrompt(
      id,
      requestId,
      text,
      attachments,
      await settingsForSend(liveSettingsTarget(current))
    )
    return true
  } catch (error) {
    const snapshot = await getMako()
      .liveSnapshot(id)
      .catch(() => null)
    if (
      snapshot?.requests.some((request) => request.id === requestId) ||
      snapshot?.control?.transfers.some(
        (transfer) => transfer.input.id === requestId
      )
    ) {
      if (snapshot) applyLiveSnapshot(snapshot)
      return true
    }
    removePendingPrompt(id, requestId)
    updateLive(id, (conversation) => ({
      ...conversation,
      sending: false,
      updatedAt: Date.now(),
    }))
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

export type QueueTarget =
  { kind: "live"; id: string } | { kind: "native"; path: string }

export async function editQueuedPrompt(
  target: QueueTarget,
  request: PendingPrompt,
  change: QueuedPromptEdit["change"]
): Promise<void> {
  const input = { requestId: request.id, expectedText: request.text, change }
  if (target.kind === "native") {
    const previous = threadsStore.get().nativeRequests
    const updated = await getMako().nativeEditQueued(input)
    if (threadsStore.get().nativeRequests === previous)
      threadsStore.set({ nativeRequests: updated })
  } else {
    applyLiveSnapshot(await getMako().liveEditQueued(target.id, input))
  }
}
