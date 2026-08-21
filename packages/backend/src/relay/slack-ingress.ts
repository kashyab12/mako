import { randomUUID } from "node:crypto"
import { connectSlackAdapter } from "@vercel/connect/chat"
import { z } from "zod"
import { readServerEnv } from "../config/env"
import { sendSlackMessage } from "../integrations/slack/client"
import {
  SlackRelayHelp,
  parseSlackRelayCommand,
} from "./commands"
import {
  activeWorker,
  enqueueRelayJob,
  readThreadMapping,
} from "./storage"

const SlackMessageEventSchema = z.object({
  bot_id: z.string().optional(),
  channel: z.string().regex(/^[CDG][A-Z0-9]+$/),
  channel_type: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().max(20_000),
  thread_ts: z.string().regex(/^\d+\.\d+$/).optional(),
  ts: z.string().regex(/^\d+\.\d+$/),
  type: z.enum(["app_mention", "message"]),
  user: z.string().min(1).max(80).optional(),
})

const SlackEventCallbackSchema = z.object({
  event: SlackMessageEventSchema,
  event_id: z.string().min(1).max(160),
  team_id: z.string().min(1).max(80),
  type: z.literal("event_callback"),
})

const SlackChallengeSchema = z.object({
  challenge: z.string(),
  type: z.literal("url_verification"),
})

const verifier = connectSlackAdapter("slack/mako").webhookVerifier

function commandText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim()
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

function eventAuthorized({
  teamId,
  userId,
}: {
  teamId: string
  userId: string
}): boolean {
  const environment = readServerEnv()
  if (!environment.SLACK_TEAM_ID || teamId !== environment.SLACK_TEAM_ID) {
    return false
  }
  return Boolean(
    environment.SLACK_ALLOWED_USER_IDS?.split(",")
      .map((value) => value.trim())
      .includes(userId)
  )
}

async function processEvent(
  callback: z.infer<typeof SlackEventCallbackSchema>
): Promise<void> {
  const event = callback.event
  if (event.bot_id || event.subtype || !event.user) return
  if (!eventAuthorized({ teamId: callback.team_id, userId: event.user })) return
  if (event.type === "message" && event.channel_type !== "im" && !event.thread_ts) {
    return
  }
  const text = commandText(event.text)
  if (!text) return
  const threadTs = event.thread_ts ?? event.ts
  const mapping = await readThreadMapping({
    channel: event.channel,
    teamId: callback.team_id,
    threadTs,
  })
  const command = parseSlackRelayCommand({
    mapping: mapping
      ? {
          effort: mapping.effort,
          fast: mapping.fast,
          harness: z
            .enum(["claude", "codex", "cursor", "grok"])
            .parse(mapping.harness),
          model: mapping.model,
          threadPath: mapping.threadPath,
        }
      : null,
    slack: {
      channel: event.channel,
      eventId: callback.event_id,
      teamId: callback.team_id,
      threadTs,
      userId: event.user,
    },
    text,
  })

  if (command.kind === "help") {
    await reply({ channel: event.channel, text: SlackRelayHelp, threadTs })
    return
  }
  if (command.kind === "status") {
    const worker = await activeWorker(callback.team_id)
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
      channel: event.channel,
      text: worker
        ? `Mako is online on *${worker.deviceName}*.${mapping ? ` This thread resumes \`${mapping.threadPath}\` with ${selection}.` : " This Slack thread has no local Mako session yet."}`
        : "Mako is offline. New work will remain queued until your laptop reconnects.",
      threadTs,
    })
    return
  }
  const queued = await enqueueRelayJob(command.payload)
  if (!queued.created) return
  const worker = await activeWorker(callback.team_id)
  await reply({
    channel: event.channel,
    text: worker
      ? `Queued for *${worker.deviceName}*. Mako will reply here when the local harness finishes.`
      : "Queued. Mako will run this when your laptop reconnects.",
    threadTs,
  })
}

async function requestVerified(request: Request, body: string): Promise<boolean> {
  try {
    return Boolean(await verifier(request, body))
  } catch {
    return false
  }
}

export async function handleSlackRelayWebhook(request: Request): Promise<Response> {
  const body = await request.text()
  if (!(await requestVerified(request, body))) {
    return new Response("Unauthorized", { status: 401 })
  }
  const value = z.json().parse(JSON.parse(body))
  const challenge = SlackChallengeSchema.safeParse(value)
  if (challenge.success) return Response.json({ challenge: challenge.data.challenge })
  const callback = SlackEventCallbackSchema.parse(value)
  await processEvent(callback)
  return Response.json({ ok: true })
}
