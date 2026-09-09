import type { LiveSessionState } from "@/lib/types"
import {
  acpStore,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import { setThreadAttention, setThreadRunning } from "@/state/threads"

export function updateLive(
  id: string,
  update: (conversation: LiveAcpConversation) => LiveAcpConversation
): LiveAcpConversation | null {
  const next = updateAcpConversation(id, (conversation) =>
    conversation.kind === "live" ? update(conversation) : conversation
  )
  return next?.kind === "live" ? next : null
}

export function activeIs(id: string): boolean {
  return acpStore.get().activeKey === id
}

export function syncThreadStatus(
  conversation: LiveAcpConversation,
  previousStatus: LiveSessionState["status"],
  previousPath?: string
): void {
  const { session, threadPath, queued } = conversation
  if (previousPath && previousPath !== threadPath) {
    setThreadRunning(previousPath, false)
    setThreadAttention(previousPath, null)
  }
  if (!threadPath) return
  setThreadRunning(
    threadPath,
    session.status === "running" || session.status === "starting"
  )
  if (session.status === "closed") {
    setThreadAttention(threadPath, null)
    return
  }
  if (conversation.permission) {
    setThreadAttention(threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: conversation.permission.title,
    })
    return
  }
  if (session.status === "running") {
    setThreadAttention(threadPath, null)
    return
  }
  if (session.status === "failed") {
    setThreadAttention(threadPath, {
      kind: "failed",
      at: Date.now(),
      detail: session.error,
    })
    return
  }
  if (session.status === "ready") setThreadAttention(threadPath, null)
  if (
    previousStatus === "running" &&
    session.status === "ready" &&
    queued.length === 0
  ) {
    setThreadAttention(
      threadPath,
      activeIs(session.id)
        ? null
        : { kind: "review", at: Date.now(), unread: true }
    )
  }
}
