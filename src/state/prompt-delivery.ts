import type {
  LiveRequest,
  LiveSessionState,
  PromptAttachment,
} from "@/lib/types"
import type { AcpBlock } from "@/lib/acp-blocks"

export interface PendingPrompt {
  id: string
  text: string
  attachments: PromptAttachment[]
  status?: LiveRequest["status"]
  displayText?: string
}

interface DeliveryInput {
  session: Pick<LiveSessionState, "status">
  blocks: AcpBlock[]
  requests?: LiveRequest[]
  pendingPrompts?: PendingPrompt[]
}
interface PromptDelivery {
  starting: PendingPrompt | null
  queued: PendingPrompt[]
}

export function recoverableRequests(input: Pick<DeliveryInput, "blocks" | "requests">): LiveRequest[] {
  const visible = new Set(input.blocks.flatMap((block) => block.type === "user" && block.requestId ? [block.requestId] : []))
  return (input.requests ?? []).filter((request) => request.status === "failed" || request.status === "uncertain" || (request.status === "interrupted" && !visible.has(request.id)))
}

/** Delivery receipts may precede provider startup. Only work behind a turn is a queue. */
export function promptDelivery(input: DeliveryInput): PromptDelivery {
  const requests = input.requests ?? []
  const accepted = new Set(requests.map((request) => request.id))
  const waiting = [
    ...requests.filter(
      (request) => request.status === "queued" || request.status === "held"
    ),
    ...(input.pendingPrompts ?? []).filter(
      (prompt) => !accepted.has(prompt.id)
    ),
  ]
  const dispatched = requests.find(
    (request) => request.status === "dispatching"
  )
  const canStart =
    input.session.status === "ready" || input.session.status === "starting"
  const first = canStart
    ? waiting[0]
    : input.session.status === "failed"
      ? input.pendingPrompts?.[0]
      : undefined
  const starting = dispatched ?? (first?.status === "held" ? undefined : first)
  const visible = new Set(
    input.blocks.flatMap((block) =>
      block.type === "user" && block.requestId ? [block.requestId] : []
    )
  )
  return {
    starting: starting && !visible.has(starting.id) ? starting : null,
    queued: waiting.filter((prompt) => prompt.id !== starting?.id),
  }
}
