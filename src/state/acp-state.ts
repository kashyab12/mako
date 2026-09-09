import type { PendingPrompt } from "@/state/prompt-delivery"
import type { ComposerTarget } from "@/state/composer-settings"
import type { LiveSnapshot } from "@/lib/types"
import type { LiveProjection } from "@/state/live-projection"
import type { AcpBlock } from "@/lib/acp-blocks"
import type {
  LivePermissionRequest,
  PromptAttachment,
  LiveSessionState,
} from "@/lib/types"
import { createHook, createStore } from "@/state/store"

export interface AcpQueuedPrompt {
  text: string
  attachments: PromptAttachment[]
}

interface AcpConversationBase {
  pendingPrompts?: PendingPrompt[]
  nativeAgents?: LiveSnapshot["nativeAgents"]
  key: string
  draftKey: string
  harness: string
  cwd: string
  title?: string
  nativePaths?: string[]
  threadPath?: string
  control?: LiveSnapshot["control"]
  requests?: LiveSnapshot["requests"]
  base?: LiveSnapshot["base"]
  revision?: number
  hydrated?: boolean
  projection?: LiveProjection
  blocks: AcpBlock[]
  queued: AcpQueuedPrompt[]
  hiddenUserPrompt: string | null
  createdAt: number
  updatedAt: number
}

export interface StartingAcpConversation extends AcpConversationBase {
  settingsTarget: ComposerTarget
  kind: "starting"
}

export interface LiveAcpConversation extends AcpConversationBase {
  kind: "live"
  session: LiveSessionState
  permission: LivePermissionRequest | null
  sending: boolean
  canceling: boolean
}

export type AcpConversation = StartingAcpConversation | LiveAcpConversation

export interface AcpState {
  activeKey: string | null
  conversations: Record<string, AcpConversation>
}

export const acpStore = createStore<AcpState>({
  activeKey: null,
  conversations: {},
})

export const useAcp = createHook(acpStore)

export function activeAcp(state: AcpState): AcpConversation | null {
  return state.activeKey ? (state.conversations[state.activeKey] ?? null) : null
}

export function activeLiveAcp(state: AcpState): LiveAcpConversation | null {
  const active = activeAcp(state)
  return active?.kind === "live" ? active : null
}

export function acpForThread(
  state: AcpState,
  path: string
): AcpConversation | null {
  let found: AcpConversation | null = null
  for (const conversation of Object.values(state.conversations)) {
    const available =
      conversation.kind === "starting" ||
      conversation.session.status !== "closed"
    if (
      available &&
      (conversation.threadPath === path ||
        conversation.nativePaths?.includes(path) ||
        conversation.control?.bindings.some(
          (binding) => binding.path === path
        )) &&
      (!found || conversation.updatedAt > found.updatedAt)
    )
      found = conversation
  }
  return found
}

export function liveAcpForThread(
  state: AcpState,
  path: string
): LiveAcpConversation | null {
  const conversation = acpForThread(state, path)
  return conversation?.kind === "live" ? conversation : null
}

export function liveAcpConversations(state: AcpState): LiveAcpConversation[] {
  return Object.values(state.conversations).filter(
    (conversation): conversation is LiveAcpConversation =>
      conversation.kind === "live" && conversation.session.status !== "closed"
  )
}

export function replaceAcpConversation(
  key: string,
  conversation: AcpConversation
): void {
  acpStore.set({
    conversations: {
      ...acpStore.get().conversations,
      [key]: conversation,
    },
  })
}

export function updateAcpConversation(
  key: string,
  update: (conversation: AcpConversation) => AcpConversation
): AcpConversation | null {
  const current = acpStore.get().conversations[key]
  if (!current) return null
  const next = update(current)
  if (next === current) return current
  replaceAcpConversation(key, next)
  return next
}

export function removeAcpConversation(key: string): AcpConversation | null {
  const state = acpStore.get()
  const current = state.conversations[key]
  if (!current) return null
  const conversations = { ...state.conversations }
  delete conversations[key]
  acpStore.set({
    conversations,
    activeKey: state.activeKey === key ? null : state.activeKey,
  })
  return current
}
