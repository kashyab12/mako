import type { AcpState } from "@/state/acp-state"

export interface AcpPresence {
  key: string
  harness: string
  nativeId?: string
  cwd: string
  createdAt: number
  title?: string
  threadPath?: string
  status: "starting" | "ready" | "running" | "needs-permission" | "failed"
}

export function selectAcpPresence(state: AcpState): AcpPresence[] {
  return Object.values(state.conversations).flatMap((conversation) => {
    if (conversation.kind === "starting") {
      const presence: AcpPresence = {
        key: conversation.key,
        harness: conversation.harness,
        cwd: conversation.cwd,
        createdAt: conversation.createdAt,
        title: conversation.title,
        threadPath: conversation.threadPath,
        status: "starting",
      }
      return [presence]
    }
    if (conversation.session.status === "closed") return []
    const presence: AcpPresence = {
      key: conversation.key,
      harness: conversation.harness,
      nativeId: conversation.session.nativeId,
      cwd: conversation.cwd,
      createdAt: conversation.createdAt,
      title: conversation.title,
      threadPath: conversation.threadPath,
      status: conversation.permission
        ? "needs-permission"
        : conversation.session.status,
    }
    return [presence]
  }).sort((left, right) => right.createdAt - left.createdAt)
}

export function sameAcpPresence(
  left: AcpPresence[],
  right: AcpPresence[]
): boolean {
  return (
    left.length === right.length &&
    left.every((presence, index) => {
      const candidate = right[index]
      return (
        candidate?.key === presence.key &&
        candidate.harness === presence.harness &&
        candidate.nativeId === presence.nativeId &&
        candidate.cwd === presence.cwd &&
        candidate.createdAt === presence.createdAt &&
        candidate.title === presence.title &&
        candidate.threadPath === presence.threadPath &&
        candidate.status === presence.status
      )
    })
  )
}
