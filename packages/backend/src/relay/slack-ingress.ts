import { randomUUID } from "node:crypto"
import { readSlackWebhook, type SlackWebhookPayload } from "@chat-adapter/slack/webhook"
import { connectSlackAdapter } from "@vercel/connect/chat"
import { z } from "zod"
import { readServerEnv } from "../config/env"
import {
  SlackChannelIdSchema,
  SlackTimestampSchema,
  sendSlackMessage,
} from "../integrations/slack/client"
import { SlackRelayHelp, parseSlackRelayCommand } from "./commands"
import { postSlackControls } from "./slack-ui"
import { activeWorker, enqueueRelayJob, readThreadMapping } from "./storage"

const RelayHarnessSchema = z.enum(["claude", "codex", "cursor", "grok"])
const ThreadMessageSchema = z.object({
  event: z.object({
    bot_id: z.string().optional(),
    channel: SlackChannelIdSchema,
    subtype: z.string().optional(),
    text: z.string().max(20_000),
    thread_ts: SlackTimestampSchema,
    ts: SlackTimestampSchema,
    type: z.literal("message"),
    user: z.string().min(1).max(80).optional(),
  }),
  event_id: z.string().min(1).max(160),
  team_id: z.string().min(1).max(80),
  type: z.literal("event_callback"),
})

const verifier = connectSlackAdapter("slack/mako").webhookVerifier

export interface PreparedSlackRelay {
  response: Response
  run?: () => Promise<void>
}

function commandText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim()
}

function eventAuthorized(teamId: string | undefined, userId: string): boolean {
  const environment = readServerEnv()
  if (!teamId || teamId !== environment.SLACK_TEAM_ID) return false
  return Boolean(
    environment.SLACK_ALLOWED_USER_IDS?.split(",")
      .map((value) => value.trim())
      .includes(userId)
  )
}

async function reply({
  channel,
  text,
  threadTs,
}: {
  channel: string
  text: string
  threadTs: string
}): Promise<void> {
  await sendSlackMessage({
    channel,
    idempotencyKey: randomUUID(),
    text,
    threadTs,
  })
}

async function processCommand({
  channel,
  eventId,
  teamId,
  text,
  threadTs,
  userId,
}: {
  channel: string
  eventId: string
  teamId: string
  text: string
  threadTs: string
  userId: string
}): Promise<void> {
  const mapping = await readThreadMapping({ channel, teamId, threadTs })
  const command = parseSlackRelayCommand({
    mapping: mapping
      ? {
          effort: mapping.effort,
          fast: mapping.fast,
          harness: RelayHarnessSchema.parse(mapping.harness),
          model: mapping.model,
          threadPath: mapping.threadPath,
        }
      : null,
    slack: { channel, eventId, teamId, threadTs, userId },
    text,
  })
  if (command.kind === "help") {
    await Promise.all([
      reply({ channel, text: SlackRelayHelp, threadTs }),
      postSlackControls({ channel, threadTs }),
    ])
    return
  }
  if (command.kind === "status") {
    const worker = await activeWorker(teamId)
    const selection = mapping
      ? [
          `harness \`${mapping.harness}\``,
          mapping.model ? `model \`${mapping.model}\`` : null,
          mapping.effort ? `reasoning \`${mapping.effort}\`` : null,
          mapping.fast === undefined ? null : `fast \`${mapping.fast ? "on" : "off"}\``,
        ]
          .filter(Boolean)
          .join(" · ")
      : null
    await reply({
      channel,
      text: worker
        ? `Mako is online on *${worker.deviceName}*.${mapping ? ` This thread resumes \`${mapping.threadPath}\` with ${selection}.` : " This Slack thread has no local Mako session yet."}`
        : "Mako is offline. New work will remain queued until your laptop reconnects.",
      threadTs,
    })
    return
  }
  const queued = await enqueueRelayJob(command.payload)
  if (!queued.created) return
  const worker = await activeWorker(teamId)
  await reply({
    channel,
    text: worker
      ? `Queued for *${worker.deviceName}*. Mako will reply here when the local harness finishes.`
      : "Queued. Mako will run this when your laptop reconnects.",
    threadTs,
  })
}

export function slackActionCommand(
  payload: Extract<SlackWebhookPayload, { kind: "block_actions" }>
): string | null {
  const action = payload.actions[0]
  if (!action) return null
  if (action.actionId === "mako-harness" && action.selectedOptionValue) {
    return `harness ${action.selectedOptionValue}`
  }
  if (action.actionId === "mako-reasoning" && action.selectedOptionValue) {
    return `reasoning ${action.selectedOptionValue}`
  }
  if (action.actionId === "mako-fast-on") return "fast on"
  if (action.actionId === "mako-fast-off") return "fast off"
  if (action.actionId === "mako-status") return "status"
  if (action.actionId === "mako-threads") return "threads"
  if (action.actionId === "mako-models") return "models"
  return null
}

async function processNormalized(payload: SlackWebhookPayload): Promise<void> {
  if (payload.kind === "app_mention" || payload.kind === "direct_message") {
    if (!payload.userId || !payload.teamId) return
    if (payload.kind === "direct_message" && (payload.botId || payload.subtype)) return
    if (!eventAuthorized(payload.teamId, payload.userId)) return
    const text = commandText(payload.text)
    if (!text) {
      await postSlackControls({ channel: payload.channelId, threadTs: payload.threadTs })
      return
    }
    await processCommand({
      channel: SlackChannelIdSchema.parse(payload.channelId),
      eventId: payload.eventId ?? randomUUID(),
      teamId: payload.teamId,
      text,
      threadTs: SlackTimestampSchema.parse(payload.threadTs),
      userId: payload.userId,
    })
    return
  }
  if (payload.kind === "slash_command") {
    if (!payload.teamId || !eventAuthorized(payload.teamId, payload.userId)) return
    const text = payload.text.trim()
    if (!text) {
      await postSlackControls({ channel: payload.channelId })
      return
    }
    const root = await sendSlackMessage({
      channel: SlackChannelIdSchema.parse(payload.channelId),
      idempotencyKey: randomUUID(),
      text: `*Mako* · ${text}`,
    })
    await processCommand({
      channel: root.channel,
      eventId: payload.triggerId ?? randomUUID(),
      teamId: payload.teamId,
      text,
      threadTs: root.ts,
      userId: payload.userId,
    })
    return
  }
  if (payload.kind === "block_actions") {
    const command = slackActionCommand(payload)
    const channel = payload.channelId
    const threadTs = payload.threadTs ?? payload.continuation?.threadTs ?? payload.messageTs
    if (
      !command ||
      !channel ||
      !threadTs ||
      !payload.teamId ||
      !eventAuthorized(payload.teamId, payload.userId)
    ) {
      return
    }
    await processCommand({
      channel: SlackChannelIdSchema.parse(channel),
      eventId: payload.triggerId ?? randomUUID(),
      teamId: payload.teamId,
      text: command,
      threadTs: SlackTimestampSchema.parse(threadTs),
      userId: payload.userId,
    })
  }
}

async function processUnsupported(payload: SlackWebhookPayload): Promise<void> {
  if (payload.kind !== "unsupported") return
  const parsed = ThreadMessageSchema.safeParse(payload.raw)
  if (!parsed.success) return
  const event = parsed.data.event
  if (event.bot_id || event.subtype || !event.user) return
  if (!eventAuthorized(parsed.data.team_id, event.user)) return
  await processCommand({
    channel: event.channel,
    eventId: parsed.data.event_id,
    teamId: parsed.data.team_id,
    text: commandText(event.text),
    threadTs: event.thread_ts,
    userId: event.user,
  })
}

export async function prepareSlackRelayWebhook(request: Request): Promise<PreparedSlackRelay> {
  let payload: SlackWebhookPayload
  try {
    payload = await readSlackWebhook(request, { webhookVerifier: verifier })
  } catch {
    return { response: new Response("Unauthorized", { status: 401 }) }
  }
  if (payload.kind === "url_verification") {
    return { response: Response.json({ challenge: payload.challenge }) }
  }
  const run = () =>
    payload.kind === "unsupported"
      ? processUnsupported(payload)
      : processNormalized(payload)
  return {
    response:
      payload.kind === "slash_command"
        ? Response.json({ response_type: "ephemeral", text: "Sent to local Mako." })
        : Response.json({ ok: true }),
    run,
  }
}
