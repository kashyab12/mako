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
  snapshot: Pick<LiveSnapshot, "blocks" | "base" | "session">,
  previous?: LiveProjection
): LiveProjection {
  const live = acpBlocksToMessages(
    snapshot.blocks,
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
