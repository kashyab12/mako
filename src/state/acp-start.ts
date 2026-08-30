import { getMako, hasBridge } from "@/lib/bridge"
import type { AcpBlock } from "@/lib/acp-blocks"
import type { AcpPromptAttachment, AcpSessionState } from "@/lib/types"
import { drainQueue, pruneResidentSessions, sendTo } from "@/state/acp-queue"
import { reduceAcpUpdates } from "@/state/acp-reducer"
import {
  acpStore,
  removeAcpConversation,
  replaceAcpConversation,
  updateAcpConversation,
  type LiveAcpConversation,
  type StartingAcpConversation,
} from "@/state/acp-state"
import { setThreadAttention } from "@/state/threads"
import { toast } from "sonner"

export type AcpStartOptions = NonNullable<
  Parameters<ReturnType<typeof getMako>["acpStart"]>[2]
>

interface BeginStartInput {
  harness: string
  cwd: string
  title?: string
  threadPath?: string
  blocks: AcpBlock[]
  hiddenUserPrompt: string | null
}

let startCounter = 0

export function beginStart(input: BeginStartInput): StartingAcpConversation {
  const now = Date.now()
  const key = `starting-${now}-${++startCounter}`
  const conversation: StartingAcpConversation = {
    kind: "starting",
    key,
    draftKey: input.threadPath ?? key,
    harness: input.harness,
    cwd: input.cwd,
    title: input.title,
    threadPath: input.threadPath,
    blocks: input.blocks,
    queued: [],
    hiddenUserPrompt: input.hiddenUserPrompt,
    createdAt: now,
    updatedAt: now,
  }
  replaceAcpConversation(key, conversation)
  acpStore.set({ activeKey: key })
  return conversation
}

export function updateStarting(
  key: string,
  patch: Partial<
    Pick<StartingAcpConversation, "hiddenUserPrompt" | "blocks">
  >
): void {
  updateAcpConversation(key, (conversation) =>
    conversation.kind === "starting"
      ? { ...conversation, ...patch, updatedAt: Date.now() }
      : conversation
  )
}

function promoteStart(
  key: string,
  session: AcpSessionState
): LiveAcpConversation | null {
  const state = acpStore.get()
  const starting = state.conversations[key]
  if (!starting || starting.kind !== "starting") {
    if (hasBridge()) void getMako().acpClose(session.id)
    return null
  }
  const buffered = starting.threadPath
    ? []
    : (state.bufferedUpdates[session.id] ?? [])
  const conversations = { ...state.conversations }
  delete conversations[key]
  const live: LiveAcpConversation = {
    ...starting,
    kind: "live",
    key: session.id,
    session,
    blocks: reduceAcpUpdates(starting.blocks, buffered),
    permission: state.bufferedPermissions[session.id] ?? null,
    sending: false,
    canceling: false,
    updatedAt: Date.now(),
  }
  conversations[session.id] = live
  const bufferedUpdates = { ...state.bufferedUpdates }
  const bufferedPermissions = { ...state.bufferedPermissions }
  delete bufferedUpdates[session.id]
  delete bufferedPermissions[session.id]
  acpStore.set({
    conversations,
    bufferedUpdates,
    bufferedPermissions,
    activeKey: state.activeKey === key ? session.id : state.activeKey,
  })
  if (live.permission && live.threadPath)
    setThreadAttention(live.threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: live.permission.title,
    })
  pruneResidentSessions()
  return live
}

export function failStart(key: string): void {
  removeAcpConversation(key)
}

export function waitForPromotion(draftKey: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const conversation = Object.values(acpStore.get().conversations).find(
        (candidate) => candidate.draftKey === draftKey
      )
      if (conversation?.kind === "live") {
        unsubscribe()
        resolve(true)
      } else if (!conversation) {
        unsubscribe()
        resolve(false)
      }
    }
    const unsubscribe = acpStore.subscribe(check)
    check()
  })
}

export async function launch(
  starting: StartingAcpConversation,
  options: AcpStartOptions,
  prompt?: string,
  attachments: AcpPromptAttachment[] = []
): Promise<boolean> {
  try {
    const session = await getMako().acpStart(
      starting.harness,
      starting.cwd,
      options
    )
    const live = promoteStart(starting.key, session)
    if (!live) return false
    if (prompt === undefined) {
      drainQueue(live.key)
      return true
    }
    return sendTo(live.key, prompt, attachments)
  } catch (error) {
    failStart(starting.key)
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}
