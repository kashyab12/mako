import { getMako, hasBridge } from "@/lib/bridge"
import type { AcpPromptAttachment } from "@/lib/types"
import {
  acpStore,
  liveAcpConversations,
  removeAcpConversation,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import { setThreadRunning } from "@/state/threads"
import { toast } from "sonner"

const MAX_RESIDENT_SESSIONS = 12

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
  attachments: AcpPromptAttachment[] = []
): Promise<boolean> {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live" || !hasBridge()) return false
  if (current.session.status === "running" || current.sending) {
    updateLive(id, (conversation) => ({
      ...conversation,
      queued: [...conversation.queued, { text, attachments }],
      updatedAt: Date.now(),
    }))
    return true
  }
  updateLive(id, (conversation) => ({
    ...conversation,
    sending: true,
    updatedAt: Date.now(),
  }))
  try {
    await getMako().acpPrompt(id, text, attachments)
    return true
  } catch (error) {
    updateLive(id, (conversation) => ({
      ...conversation,
      sending: false,
      updatedAt: Date.now(),
    }))
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

export function drainQueue(id: string): void {
  const current = acpStore.get().conversations[id]
  if (
    !current ||
    current.kind !== "live" ||
    current.session.status !== "ready" ||
    current.sending
  )
    return
  const [queued, ...rest] = current.queued
  if (!queued) return
  updateLive(id, (conversation) => ({ ...conversation, queued: rest }))
  void sendTo(id, queued.text, queued.attachments).then((sent) => {
    if (sent) return
    updateLive(id, (conversation) => ({
      ...conversation,
      queued: [queued, ...conversation.queued],
    }))
  })
}

export function pruneResidentSessions(): void {
  const state = acpStore.get()
  const live = liveAcpConversations(state)
  if (live.length <= MAX_RESIDENT_SESSIONS) return
  const removable = live
    .filter(
      (conversation) =>
        conversation.key !== state.activeKey &&
        conversation.session.status !== "running" &&
        !conversation.permission &&
        !conversation.sending &&
        !conversation.canceling &&
        conversation.queued.length === 0
    )
    .sort((left, right) => left.updatedAt - right.updatedAt)
  for (let count = live.length; count > MAX_RESIDENT_SESSIONS; count -= 1) {
    const conversation = removable.shift()
    if (!conversation) return
    if (hasBridge()) void getMako().acpClose(conversation.session.id)
    if (conversation.threadPath)
      setThreadRunning(conversation.threadPath, false)
    removeAcpConversation(conversation.key)
  }
}
