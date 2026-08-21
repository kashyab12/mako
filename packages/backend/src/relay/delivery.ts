import { createHash } from "node:crypto"
import { sendSlackMessage } from "../integrations/slack/client"
import { markRelayDelivered } from "./storage"
import type { RelayCompletion, RelayJobPayload } from "./types"

function messageId(jobId: string, index: number): string {
  if (index === 0) return jobId
  const value = createHash("sha256")
    .update(`${jobId}:${index}`)
    .digest("hex")
    .slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`
}

export function formatHarnessReplies(text: string): string[] {
  const trimmed = text.trim()
  const normalized =
    !trimmed.includes("\n") && trimmed.includes("\\n")
      ? trimmed.replaceAll("\\n", "\n")
      : trimmed
  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > 11_900) {
    const paragraph = remaining.lastIndexOf("\n\n", 11_900)
    const line = remaining.lastIndexOf("\n", 11_900)
    const boundary = Math.max(paragraph, line)
    const end = boundary >= 6_000 ? boundary : 11_900
    chunks.push(remaining.slice(0, end).trimEnd())
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks.length > 0 ? chunks : ["The harness completed without a text response."]
}

export async function deliverRelayCompletion({
  completion,
  payload,
}: {
  completion: RelayCompletion
  payload: RelayJobPayload
}): Promise<void> {
  const chunks = formatHarnessReplies(completion.result)
  for (const [index, text] of chunks.entries()) {
    await sendSlackMessage({
      channel: payload.slack.channel,
      idempotencyKey: messageId(completion.jobId, index),
      text,
      threadTs: payload.slack.threadTs,
    })
  }
  await markRelayDelivered({ completion, payload })
}
