import { createHash, randomUUID } from "node:crypto"
import {
  readSlackWebhook,
  type SlackFile,
  type SlackReadOptions,
  type SlackWebhookPayload,
} from "@chat-adapter/slack/webhook"
import { connectSlackAdapter } from "@vercel/connect/chat"
import { z } from "zod"
import { readServerEnv } from "../config/env"
import {
  SlackChannelIdSchema,
  SlackTimestampSchema,
  sendSlackMessage,
  setSlackAgentStatus,
} from "../integrations/slack/client"
import { SlackRelayHelp, parseSlackRelayCommand } from "./commands"
import { postSlackControls } from "./slack-ui"
import {
  activeWorker,
  enqueueRelayJob,
  readThreadMapping,
  relayQueueStatus,
  requestRelayStop,
  workerById,
} from "./storage"
import {
  RelayHarnessSchema,
  type RemoteAttachment,
} from "./types"
const AgentSessionStoppedSchema = z.object({
  event: z.object({
    channel: SlackChannelIdSchema,
    event_ts: SlackTimestampSchema,
    streaming_message_ts: z.array(SlackTimestampSchema).max(20),
    thread_ts: SlackTimestampSchema,
    type: z.literal("agent_session_stopped"),
    user: z.string().min(1).max(80),
  }),
  event_id: z.string().min(1).max(160),
  team_id: z.string().min(1).max(80),
  type: z.literal("event_callback"),
})

const ThreadMessageSchema = z.object({
  event: z.object({
    bot_id: z.string().optional(),
    channel: SlackChannelIdSchema,
    subtype: z.string().optional(),
    files: z
      .array(
        z.object({
          id: z.string().min(1).max(160),
          filetype: z.string().max(80).optional(),
          mimetype: z.string().max(255).optional(),
          name: z.string().max(255).optional(),
          size: z.number().int().nonnegative().optional(),
          title: z.string().max(255).optional(),
        })
      )
      .max(20)
      .optional(),
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

function slackWebhookOptions(): SlackReadOptions {
  const environment = readServerEnv()
  if (environment.SLACK_SIGNING_SECRET) {
    return { signingSecret: environment.SLACK_SIGNING_SECRET }
  }
  return {
    webhookVerifier: connectSlackAdapter(environment.SLACK_CONNECTOR ?? "slack/mako")
      .webhookVerifier,
  }
}

export interface PreparedSlackRelay {
  response: Response
  run?: () => Promise<void>
}

function commandText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim()
}

function attachmentName(file: {
  id: string
  name?: string
  title?: string
  filetype?: string
}): string {
  return (
    file.name ??
    file.title ??
    `${file.id}${file.filetype ? `.${file.filetype}` : ""}`
  )
}

function normalizedAttachments(files: SlackFile[] | undefined): RemoteAttachment[] {
  return (files ?? []).map((file) => ({
    id: file.id,
    kind: file.type,
    name: attachmentName(file),
    mimeType: file.mimeType,
    size: file.size,
  }))
}

function rawAttachments(
  files: z.infer<typeof ThreadMessageSchema>["event"]["files"]
): RemoteAttachment[] {
  return (files ?? []).map((file) => ({
    id: file.id,
    kind: file.mimetype?.startsWith("image/")
      ? "image"
      : file.mimetype?.startsWith("video/")
        ? "video"
        : file.mimetype?.startsWith("audio/")
          ? "audio"
          : "file",
    name: attachmentName(file),
    mimeType: file.mimetype,
    size: file.size,
  }))
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

function slackMessageId(seed: string): string {
  const value = createHash("sha256").update(seed).digest("hex").slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`
}

async function reply({
  channel,
  idempotencyKey,
  text,
  threadTs,
}: {
  channel: string
  idempotencyKey: string
  text: string
  threadTs: string
}): Promise<void> {
  await sendSlackMessage({
    channel,
    idempotencyKey: slackMessageId(idempotencyKey),
    text,
    threadTs,
  })
}

async function processCommand({
  attachments = [],
  channel,
  eventId,
  teamId,
  text,
  threadTs,
  userId,
}: {
  attachments?: RemoteAttachment[]
  channel: string
  eventId: string
  teamId: string
  text: string
  threadTs: string
  userId: string
}): Promise<void> {
  const origin = {
    provider: "slack",
    tenantId: teamId,
    conversationId: channel,
    threadId: threadTs,
    eventId,
    userId,
  }
  const mapping = await readThreadMapping(origin)
  const command = parseSlackRelayCommand({
    attachments,
    mapping: mapping
      ? {
          effort: mapping.effort,
          fast: mapping.fast,
          harness: RelayHarnessSchema.parse(mapping.harness),
          model: mapping.model,
          threadPath: mapping.threadPath,
        }
      : null,
    origin,
    text,
  })
  if (command.kind === "help") {
    await Promise.all([
      reply({
        channel,
        idempotencyKey: `${eventId}:help`,
        text: SlackRelayHelp,
        threadTs,
      }),
      postSlackControls({ channel, threadTs, idempotencyKey: `${eventId}:controls` }),
    ])
    return
  }
  if (command.kind === "stop") {
    const count = await requestRelayStop(origin)
    await setSlackAgentStatus({
      channel,
      status: "active",
      threadTs,
    }).catch(() => undefined)
    await reply({
      channel,
      idempotencyKey: `${eventId}:stop`,
      text: count > 0 ? "Stopping the local agent…" : "No local run is active for this thread.",
      threadTs,
    })
    return
  }
  if (command.kind === "status") {
    const [worker, queue] = await Promise.all([
      mapping
        ? workerById(teamId, mapping.deviceId)
        : activeWorker(teamId),
      relayQueueStatus(origin),
    ])
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
      idempotencyKey: `${eventId}:status`,
      text: `${worker ? `Mako is online on *${worker.deviceName}*.` : "Mako is offline."}${mapping ? ` This thread resumes \`${mapping.threadPath}\` with ${selection}.` : " This Slack thread has no local Mako session yet."}${queue.running || queue.queued ? ` *${queue.running} working · ${queue.queued} queued.*` : ""}${worker ? "" : " New work will remain queued until your worker reconnects."}`,
      threadTs,
    })
    return
  }
  if (command.kind === "interrupt")
    await requestRelayStop(command.payload.origin)
  const worker = mapping
    ? await workerById(teamId, mapping.deviceId)
    : await activeWorker(teamId)
  const payload = {
    ...command.payload,
    slack: { channel, eventId, teamId, threadTs, userId },
  }
  const queued = await enqueueRelayJob(payload, mapping?.deviceId)
  if (!queued.created) return
  await reply({
    channel,
    idempotencyKey: `${eventId}:queued`,
    text:
      command.kind === "interrupt"
        ? "Stopping the current turn. Your message is next in this Slack thread."
        : worker
          ? `Queued for *${worker.deviceName}*. Mako will stream progress and the reply here.`
          : "Queued. Mako will run this when your worker reconnects.",
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
  if (action.actionId === "mako-stop") return "stop"
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
    const attachments = normalizedAttachments(payload.files)
    if (!text && attachments.length === 0) {
      await postSlackControls({ channel: payload.channelId, threadTs: payload.threadTs })
      return
    }
    await processCommand({
      attachments,
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
      idempotencyKey: slackMessageId(
        `${payload.triggerId ?? `${payload.teamId}:${payload.userId}:${text}`}:root`
      ),
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
  const stopped = AgentSessionStoppedSchema.safeParse(payload.raw)
  if (stopped.success) {
    const { event, event_id: eventId, team_id: teamId } = stopped.data
    if (!eventAuthorized(teamId, event.user)) return
    const origin = {
      provider: "slack",
      tenantId: teamId,
      conversationId: event.channel,
      threadId: event.thread_ts,
      eventId,
      userId: event.user,
    }
    const count = await requestRelayStop(origin)
    await setSlackAgentStatus({
      channel: event.channel,
      status: "active",
      threadTs: event.thread_ts,
    }).catch(() => undefined)
    await reply({
      channel: event.channel,
      idempotencyKey: `${eventId}:stopped`,
      text: count > 0 ? "Stopping the local agent…" : "No local run is active for this thread.",
      threadTs: event.thread_ts,
    })
    return
  }
  const parsed = ThreadMessageSchema.safeParse(payload.raw)
  if (!parsed.success) return
  const event = parsed.data.event
  if (event.bot_id || event.subtype || !event.user) return
  if (!eventAuthorized(parsed.data.team_id, event.user)) return
  await processCommand({
    attachments: rawAttachments(event.files),
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
    payload = await readSlackWebhook(request, slackWebhookOptions())
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
