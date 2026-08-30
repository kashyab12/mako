import type {
  AcpPermissionRequest,
  AcpSessionState,
  AcpUpdate,
} from "@/lib/types"
import { reduceAcpUpdates } from "@/state/acp-reducer"
import { drainQueue, pruneResidentSessions } from "@/state/acp-queue"
import {
  acpStore,
  removeAcpConversation,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import {
  setThreadAttention,
  setThreadRunning,
  setThreadWorkDetail,
  threadsStore,
} from "@/state/threads"
import { toast } from "sonner"

const MAX_BUFFERED_UPDATES = 2_000
const MAX_BUFFERED_SESSIONS = 16

export function updateLive(
  id: string,
  update: (conversation: LiveAcpConversation) => LiveAcpConversation
): LiveAcpConversation | null {
  const next = updateAcpConversation(id, (conversation) =>
    conversation.kind === "live" ? update(conversation) : conversation
  )
  return next?.kind === "live" ? next : null
}

function bufferUpdates(id: string, updates: AcpUpdate[]): void {
  if (updates.length === 0) return
  const state = acpStore.get()
  const current = state.bufferedUpdates[id] ?? []
  const bufferedUpdates = {
    ...state.bufferedUpdates,
    [id]: [...current, ...updates].slice(-MAX_BUFFERED_UPDATES),
  }
  const ids = Object.keys(bufferedUpdates)
  const oldest = ids[0]
  if (ids.length > MAX_BUFFERED_SESSIONS && oldest)
    delete bufferedUpdates[oldest]
  acpStore.set({ bufferedUpdates })
}

export function activeIs(id: string): boolean {
  return acpStore.get().activeKey === id
}

function syncThreadStatus(
  conversation: LiveAcpConversation,
  previousStatus: AcpSessionState["status"]
): void {
  const { session, threadPath, queued } = conversation
  if (!threadPath) return
  setThreadRunning(threadPath, session.status === "running")
  if (session.status === "running") {
    if (!conversation.permission) setThreadAttention(threadPath, null)
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
  if (session.status === "failed") {
    setThreadAttention(threadPath, {
      kind: "failed",
      at: Date.now(),
      detail: session.error,
    })
    return
  }
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

export function applyAcpSession(session: AcpSessionState): void {
  const current = acpStore.get().conversations[session.id]
  if (!current || current.kind !== "live") {
    if (session.status === "failed" || session.status === "closed") {
      const bufferedUpdates = { ...acpStore.get().bufferedUpdates }
      const bufferedPermissions = { ...acpStore.get().bufferedPermissions }
      delete bufferedUpdates[session.id]
      delete bufferedPermissions[session.id]
      acpStore.set({ bufferedUpdates, bufferedPermissions })
    }
    return
  }
  const previousStatus = current.session.status
  if (session.status === "closed") {
    if (current.threadPath) {
      setThreadRunning(current.threadPath, false)
      setThreadAttention(current.threadPath, null)
    }
    removeAcpConversation(session.id)
    return
  }
  const next = updateLive(session.id, (conversation) => ({
    ...conversation,
    session,
    sending: false,
    canceling: session.status === "running" ? conversation.canceling : false,
    permission: conversation.permission,
    updatedAt: Date.now(),
  }))
  if (!next) return
  syncThreadStatus(next, previousStatus)
  if (session.status === "failed" && session.error)
    toast.error(session.error, { description: session.title })

  if (session.status === "ready") drainQueue(session.id)
  if (session.status !== "running") pruneResidentSessions()
}

export function applyAcpUpdate(id: string, update: AcpUpdate): void {
  applyAcpUpdates(id, [update])
}

export function applyAcpUpdates(id: string, updates: AcpUpdate[]): void {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live") {
    bufferUpdates(id, updates)
    return
  }
  let hidden = false
  const visible = current.hiddenUserPrompt
    ? updates.filter((update) => {
        if (
          !hidden &&
          update.kind === "user" &&
          update.text === current.hiddenUserPrompt
        ) {
          hidden = true
          return false
        }
        return true
      })
    : updates
  const next = updateLive(id, (conversation) => ({
    ...conversation,
    blocks: reduceAcpUpdates(conversation.blocks, visible),
    hiddenUserPrompt: hidden ? null : conversation.hiddenUserPrompt,
    updatedAt: Date.now(),
  }))
  if (!next?.threadPath) return
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const update = visible[index]
    if (update.kind === "tool") {
      setThreadWorkDetail(next.threadPath, update.title)
      return
    }
    if (update.kind === "text") {
      setThreadWorkDetail(next.threadPath, "Writing response")
      return
    }
    if (update.kind === "thinking") {
      setThreadWorkDetail(next.threadPath, "Reasoning")
      return
    }
  }
}

export function applyAcpPermission(
  request: AcpPermissionRequest,
  activate: (key: string) => boolean
): void {
  const state = acpStore.get()
  const current = state.conversations[request.sessionId]
  if (!current || current.kind !== "live") {
    const bufferedPermissions = {
      ...state.bufferedPermissions,
      [request.sessionId]: request,
    }
    const ids = Object.keys(bufferedPermissions)
    const oldest = ids[0]
    if (ids.length > MAX_BUFFERED_SESSIONS && oldest)
      delete bufferedPermissions[oldest]
    acpStore.set({ bufferedPermissions })
    return
  }
  const next = updateLive(request.sessionId, (conversation) => ({
    ...conversation,
    permission: request,
    updatedAt: Date.now(),
  }))
  if (!next) return
  if (next.threadPath)
    setThreadAttention(next.threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: request.title,
    })
  if (!activeIs(request.sessionId)) {
    toast(`${next.session.title ?? next.session.harness} needs input`, {
      description: request.title,
      action: {
        label: "View",
        onClick: () => {
          const ref = next.threadPath
            ? threadsStore
                .get()
                .threads.find((candidate) => candidate.path === next.threadPath)
            : undefined
          if (ref)
            void import("@/state/thread-viewing").then(
              ({ threadViewingActions }) => threadViewingActions.view(ref)
            )
          else activate(request.sessionId)
        },
      },
    })
  }
}
