import { createHash } from "node:crypto"
import {
  appendSlackStream,
  sendSlackMessage,
  setSlackAgentStatus,
  startSlackStream,
  stopSlackStream,
  type SlackStreamChunk,
} from "../integrations/slack/client"
import {
  markRelayDelivered,
  recordRelayProgress,
  recordRelayStream,
  recordRelayStreamClosed,
  relayDeliveryState,
  relayProgressTarget,
} from "./storage"
import type {
  RelayCompletion,
  RelayJobPayload,
  RelayLease,
  RelayProgress,
} from "./types"

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
  while (remaining.length > 11_000) {
    const paragraph = remaining.lastIndexOf("\n\n", 11_000)
    const line = remaining.lastIndexOf("\n", 11_000)
    const boundary = Math.max(paragraph, line)
    const end = boundary >= 6_000 ? boundary : 11_000
    chunks.push(remaining.slice(0, end).trimEnd())
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks.length > 0 ? chunks : ["The harness completed without a text response."]
}

function deliveryTitle(payload: RelayJobPayload): string {
  if ("text" in payload && payload.text.trim())
    return (payload.text.trim().split("\n")[0] ?? "").slice(0, 80)
  return payload.kind === "resume" || payload.kind === "resume-query"
    ? "Continue local agent session"
    : "Local agent task"
}

function taskTitle(harness: string): string {
  return `Run ${harness} on the connected Mako worker`
}

export async function startRelayDelivery({
  defaultHarness,
  deviceId,
  deviceName,
  lease,
}: {
  defaultHarness: string
  deviceId: string
  deviceName: string
  lease: RelayLease
}): Promise<void> {
  const { payload } = lease
  if (payload.origin.provider !== "slack") return
  const existing = await relayDeliveryState(lease.jobId)
  if (existing.streamTs) return
  const harness = payload.selection.harness ?? defaultHarness
  try {
    await setSlackAgentStatus({
      channel: payload.origin.conversationId,
      initiatorUserId: payload.origin.userId,
      status: "processing",
      threadTs: payload.origin.threadId,
      title: deliveryTitle(payload),
    })
    const stream = await startSlackStream({
      channel: payload.origin.conversationId,
      chunks: [
        { type: "plan_update", title: deliveryTitle(payload) },
        {
          type: "task_update",
          id: lease.jobId,
          title: taskTitle(harness),
          status: "in_progress",
          details: `Running on ${deviceName}`,
        },
      ],
      recipientTeamId: payload.origin.tenantId,
      recipientUserId: payload.origin.userId,
      threadTs: payload.origin.threadId,
    })
    try {
      await recordRelayStream({ deviceId, jobId: lease.jobId, streamTs: stream.ts })
    } catch (error) {
      await stopSlackStream({
        channel: payload.origin.conversationId,
        chunks: [
          {
            type: "task_update",
            id: lease.jobId,
            title: taskTitle(harness),
            status: "error",
            details: "The local worker could not claim this stream",
          },
        ],
        sessionStatus: "suspended",
        ts: stream.ts,
      }).catch(() => undefined)
      throw error
    }
  } catch {
    await setSlackAgentStatus({
      channel: payload.origin.conversationId,
      initiatorUserId: payload.origin.userId,
      status: "processing",
      threadTs: payload.origin.threadId,
      title: deliveryTitle(payload),
    }).catch(() => undefined)
  }
}

export async function deliverRelayProgress(
  progress: RelayProgress
): Promise<boolean> {
  const target = await relayProgressTarget(progress)
  if (!target.accepted || !target.streamTs) return false
  if (target.payload.origin.provider !== "slack") return false
  await recordRelayProgress(progress)
  await appendSlackStream({
    channel: target.payload.origin.conversationId,
    chunks: [{ type: "markdown_text", text: progress.text }],
    ts: target.streamTs,
  })
  return true
}

export async function deliverRelayCompletion({
  completion,
  payload,
}: {
  completion: RelayCompletion
  payload: RelayJobPayload
}): Promise<void> {
  if (payload.origin.provider !== "slack")
    throw new Error(`No delivery adapter for ${payload.origin.provider}`)
  const delivery = await relayDeliveryState(completion.jobId)
  if (delivery.status === "delivered") return
  const chunks = formatHarnessReplies(completion.result)
  const sessionStatus =
    completion.status === "failed" ? "suspended" : "active"
  if (delivery.streamTs) {
    const finalChunks: SlackStreamChunk[] = [
      {
        type: "task_update",
        id: completion.jobId,
        title: taskTitle(completion.harness),
        status: completion.status === "done" ? "complete" : "error",
        details:
          completion.status === "stopped"
            ? "Stopped by the user"
            : completion.status === "failed"
              ? "The local agent failed"
              : "Completed locally",
      },
    ]
    if (
      delivery.streamedChars === 0 &&
      !completion.progressFailed &&
      chunks[0]
    )
      finalChunks.push({ type: "markdown_text", text: chunks[0] })
    let streamStopped = true
    if (!delivery.streamClosed) {
      try {
        await stopSlackStream({
          channel: payload.origin.conversationId,
          chunks: finalChunks,
          sessionStatus,
          ts: delivery.streamTs,
        })
        await recordRelayStreamClosed({
          deviceId: completion.deviceId,
          jobId: completion.jobId,
        })
      } catch {
        streamStopped = false
        await setSlackAgentStatus({
          channel: payload.origin.conversationId,
          status: sessionStatus,
          threadTs: payload.origin.threadId,
        }).catch(() => undefined)
      }
    }
    const fullReplyNeeded = completion.progressFailed || !streamStopped
    const firstPosted =
      streamStopped && !completion.progressFailed && delivery.streamedChars === 0
        ? 1
        : 0
    if (fullReplyNeeded || delivery.streamedChars === 0) {
      for (const [index, text] of chunks.slice(firstPosted).entries()) {
        await sendSlackMessage({
          channel: payload.origin.conversationId,
          idempotencyKey: messageId(completion.jobId, index + firstPosted),
          text,
          threadTs: payload.origin.threadId,
        })
      }
    }
  } else {
    for (const [index, text] of chunks.entries()) {
      await sendSlackMessage({
        channel: payload.origin.conversationId,
        idempotencyKey: messageId(completion.jobId, index),
        text,
        threadTs: payload.origin.threadId,
      })
    }
    await setSlackAgentStatus({
      channel: payload.origin.conversationId,
      status: sessionStatus,
      threadTs: payload.origin.threadId,
    }).catch(() => undefined)
  }
  await markRelayDelivered({ completion, payload })
}
