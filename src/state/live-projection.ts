import { promptDelivery, type PendingPrompt } from "@/state/prompt-delivery"
import type { AcpConversation } from "@/state/acp-state"
import type { LiveSnapshot, ChatMessage } from "@/lib/types"
import { acpBlocksToMessages, type AcpPlanEntry } from "@/lib/acp-blocks"
import { threadToMessages } from "@/lib/foreign-thread"
import { reconcileMessages } from "@/lib/reconcile"
import { foldTools } from "@/lib/tools"
import { toExchanges, type Exchange } from "@/lib/exchanges"

export interface LiveProjection {
  messages: ChatMessage[]
  exchanges: Exchange[]
  plan: AcpPlanEntry[]
}
export function projectLive(
  snapshot: Pick<LiveSnapshot, "blocks" | "base"> & {
    session: Pick<LiveSnapshot["session"], "status" | "harness">
    requests?: LiveSnapshot["requests"]
  },
  previous?: LiveProjection,
  pendingPrompts?: PendingPrompt[]
): LiveProjection {
  const { starting } = promptDelivery({ ...snapshot, pendingPrompts })
  const blocks = starting
    ? [
        ...snapshot.blocks,
        {
          type: "user" as const,
          requestId: starting.id,
          text: starting.displayText ?? starting.text,
          attachments: starting.attachments.map((attachment) => ({
            type: "attachment" as const,
            name: attachment.name,
            mimeType: attachment.mimeType,
            source: attachment.path
              ? { kind: "file" as const, path: attachment.path }
              : attachment.data
                ? { kind: "inline" as const, data: attachment.data }
                : {
                    kind: "unavailable" as const,
                    reason: "Attachment is being prepared",
                  },
          })),
        },
      ]
    : snapshot.blocks
  const live = acpBlocksToMessages(
    blocks,
    snapshot.session.status === "running",
    snapshot.session.harness
  )
  const base = snapshot.base
    ? threadToMessages(
        snapshot.base.entries,
        snapshot.base.start,
        snapshot.base.ref.harness
      )
    : []
  const messages = reconcileMessages(
    previous?.messages ?? [],
    foldTools([...base, ...live.messages])
  )
  return {
    messages,
    exchanges: toExchanges(messages, previous?.exchanges),
    plan: live.plan,
  }
}

export function projectAcp(conversation: AcpConversation): LiveProjection {
  return projectLive(
    {
      blocks: conversation.blocks,
      base: conversation.base ?? null,
      requests: conversation.requests,
      session:
        conversation.kind === "live"
          ? conversation.session
          : { status: "starting", harness: conversation.harness },
    },
    conversation.projection,
    conversation.pendingPrompts
  )
}
