import { deleteTokenCacheEntry, getToken } from "@vercel/connect"
import { z } from "zod"
import { readOptionalServerEnv } from "../../config/env"

export const SlackChannelIdSchema = z.string().regex(/^[CDG][A-Z0-9]+$/)
export const SlackTimestampSchema = z.string().regex(/^\d+\.\d+$/)
const SlackMessageTextSchema = z.string().transform((value) => value.slice(0, 12_000))
const SlackMetadataTextSchema = z.string().transform((value) => value.slice(0, 2_000))
const TokenParams = {
  subject: { type: "app" as const },
  scopes: ["*"],
}

const SlackErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

const SlackIdentitySchema = z.object({
  ok: z.literal(true),
  team: z.string().optional(),
  team_id: z.string().optional(),
  user: z.string().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
})

const SlackChannelsSchema = z.object({
  ok: z.literal(true),
  channels: z.array(
    z.object({
      id: SlackChannelIdSchema,
      name: z.string(),
      is_channel: z.boolean().optional(),
      is_group: z.boolean().optional(),
      is_im: z.boolean().optional(),
      is_member: z.boolean().optional(),
      is_private: z.boolean().optional(),
      purpose: z.object({ value: SlackMetadataTextSchema }).optional(),
      topic: z.object({ value: SlackMetadataTextSchema }).optional(),
    })
  ),
  response_metadata: z.object({ next_cursor: z.string() }).optional(),
})

const SlackMessagesSchema = z.object({
  ok: z.literal(true),
  messages: z.array(
    z.object({
      type: z.string(),
      user: z.string().optional(),
      bot_id: z.string().optional(),
      text: SlackMessageTextSchema,
      ts: SlackTimestampSchema,
      thread_ts: SlackTimestampSchema.optional(),
      reply_count: z.number().int().nonnegative().optional(),
    })
  ),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string() }).optional(),
})

const SlackPostMessageSchema = z.object({
  ok: z.literal(true),
  channel: SlackChannelIdSchema,
  ts: SlackTimestampSchema,
  message: z.object({ text: z.string() }).optional(),
})

export type SlackIdentity = z.infer<typeof SlackIdentitySchema>
export type SlackChannels = z.infer<typeof SlackChannelsSchema>
export type SlackMessages = z.infer<typeof SlackMessagesSchema>
export type SlackPostMessage = z.infer<typeof SlackPostMessageSchema>

type SlackCredential =
  | { kind: "direct"; token: string }
  | { connector: string; kind: "connector"; token: string }

async function slackCredential(): Promise<SlackCredential> {
  const environment = readOptionalServerEnv()
  if (environment.SLACK_BOT_TOKEN) {
    return { kind: "direct", token: environment.SLACK_BOT_TOKEN }
  }
  const connector = environment.SLACK_CONNECTOR ?? "slack/mako"
  return {
    connector,
    kind: "connector",
    token: await getToken(connector, TokenParams),
  }
}

function invalidateConnectorToken(credential: SlackCredential): boolean {
  if (credential.kind !== "connector") return false
  deleteTokenCacheEntry(credential.connector, TokenParams)
  return true
}

interface SlackAttempt {
  attempt: number
  refreshedToken: boolean
}

const InitialAttempt: SlackAttempt = { attempt: 0, refreshedToken: false }

function retryDelay(attempt: number): number {
  return 250 * 2 ** attempt
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function slackFetch(
  method: string,
  input: Record<string, string | number | boolean | undefined>,
  state: SlackAttempt = InitialAttempt
): Promise<z.output<typeof z.json>> {
  const credential = await slackCredential()
  let response: Response
  try {
    response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    if (state.attempt >= 2) throw error
    await sleep(retryDelay(state.attempt))
    return slackFetch(method, input, {
      ...state,
      attempt: state.attempt + 1,
    })
  }
  if (response.status === 429) {
    const parsed = z.coerce
      .number()
      .int()
      .positive()
      .safeParse(response.headers.get("Retry-After"))
    const retryAfter = parsed.success ? parsed.data * 1_000 : 1_000
    if (state.attempt >= 2 || retryAfter > 10_000) {
      throw new Error(`Slack rate limited the request; retry after ${retryAfter}ms`)
    }
    await sleep(retryAfter)
    return slackFetch(method, input, {
      ...state,
      attempt: state.attempt + 1,
    })
  }
  if (response.status >= 500 && state.attempt < 2) {
    await sleep(retryDelay(state.attempt))
    return slackFetch(method, input, {
      ...state,
      attempt: state.attempt + 1,
    })
  }
  const payload = z.json().parse(await response.json())
  if (!response.ok) {
    if (
      !state.refreshedToken &&
      response.status === 401 &&
      invalidateConnectorToken(credential)
    ) {
      return slackFetch(method, input, {
        attempt: state.attempt + 1,
        refreshedToken: true,
      })
    }
    throw new Error(`Slack returned HTTP ${response.status}`)
  }
  const failure = SlackErrorSchema.safeParse(payload)
  if (failure.success) {
    if (
      !state.refreshedToken &&
      ["invalid_auth", "token_expired", "token_revoked"].includes(
        failure.data.error
      ) &&
      invalidateConnectorToken(credential)
    ) {
      return slackFetch(method, input, {
        attempt: state.attempt + 1,
        refreshedToken: true,
      })
    }
    throw new Error(`Slack rejected the request: ${failure.data.error}`)
  }
  return payload
}

export async function slackIdentity(): Promise<SlackIdentity> {
  return SlackIdentitySchema.parse(await slackFetch("auth.test", {}))
}

export async function listSlackChannels({
  cursor,
  limit,
}: {
  cursor?: string
  limit: number
}): Promise<SlackChannels> {
  return SlackChannelsSchema.parse(
    await slackFetch("conversations.list", {
      cursor,
      exclude_archived: true,
      limit,
      types: "public_channel,private_channel,mpim,im",
    })
  )
}

export async function readSlackMessages({
  channel,
  cursor,
  limit,
}: {
  channel: string
  cursor?: string
  limit: number
}): Promise<SlackMessages> {
  return SlackMessagesSchema.parse(
    await slackFetch("conversations.history", { channel, cursor, limit })
  )
}

export async function readSlackThread({
  channel,
  cursor,
  limit,
  threadTs,
}: {
  channel: string
  cursor?: string
  limit: number
  threadTs: string
}): Promise<SlackMessages> {
  return SlackMessagesSchema.parse(
    await slackFetch("conversations.replies", {
      channel,
      cursor,
      limit,
      ts: threadTs,
    })
  )
}

export async function sendSlackMessage({
  channel,
  idempotencyKey,
  text,
  threadTs,
}: {
  channel: string
  idempotencyKey: string
  text: string
  threadTs?: string
}): Promise<SlackPostMessage> {
  return SlackPostMessageSchema.parse(
    await slackFetch("chat.postMessage", {
      channel,
      client_msg_id: idempotencyKey,
      markdown_text: text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    })
  )
}
