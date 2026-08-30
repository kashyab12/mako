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

const SlackOkSchema = z.object({ ok: z.literal(true) })

const SlackTaskUpdateChunkSchema = z.object({
  type: z.literal("task_update"),
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(256),
  status: z.enum(["pending", "in_progress", "complete", "error"]),
  details: z.string().max(256).optional(),
  hide_title: z.boolean().optional(),
  output: z.string().max(256).optional(),
  sources: z
    .array(
      z.object({
        type: z.literal("url"),
        text: z.string().min(1).max(200),
        url: z.url(),
      })
    )
    .max(10)
    .optional(),
})

const SlackPlanUpdateChunkSchema = z.object({
  type: z.literal("plan_update"),
  title: z.string().min(1).max(256),
})

const SlackMarkdownChunkSchema = z.object({
  type: z.literal("markdown_text"),
  text: z.string().min(1).max(12_000),
})

export const SlackStreamChunkSchema = z.discriminatedUnion("type", [
  SlackTaskUpdateChunkSchema,
  SlackPlanUpdateChunkSchema,
  SlackMarkdownChunkSchema,
])
export type SlackStreamChunk = z.infer<typeof SlackStreamChunkSchema>

const SlackFileInfoSchema = z.object({
  ok: z.literal(true),
  file: z.object({
    id: z.string(),
    mimetype: z.string().optional(),
    name: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    title: z.string().optional(),
    url_private: z.url().optional(),
    url_private_download: z.url().optional(),
  }),
})

const SlackUploadUrlSchema = z.object({
  ok: z.literal(true),
  file_id: z.string().min(1),
  upload_url: z.url(),
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
  input: Record<string, z.input<typeof z.json> | undefined>,
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

export async function sendSlackBlocks({
  blocks,
  channel,
  idempotencyKey,
  text,
  threadTs,
}: {
  blocks: z.input<typeof z.json>
  channel: string
  idempotencyKey: string
  text: string
  threadTs?: string
}): Promise<SlackPostMessage> {
  return SlackPostMessageSchema.parse(
    await slackFetch("chat.postMessage", {
      blocks,
      channel,
      client_msg_id: idempotencyKey,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
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

export async function setSlackAgentStatus({
  channel,
  initiatorUserId,
  status,
  threadTs,
  title,
}: {
  channel: string
  initiatorUserId?: string
  status: "active" | "closed" | "processing" | "suspended"
  threadTs: string
  title?: string
}): Promise<void> {
  SlackOkSchema.parse(
    await slackFetch("agents.sessions.setStatus", {
      channel_id: channel,
      initiator_user_id: initiatorUserId,
      status,
      thread_ts: threadTs,
      title,
    })
  )
}

export async function renameSlackAgentSession({
  channel,
  threadTs,
  title,
}: {
  channel: string
  threadTs: string
  title: string
}): Promise<void> {
  SlackOkSchema.parse(
    await slackFetch("agents.sessions.rename", {
      channel_id: channel,
      thread_ts: threadTs,
      title,
    })
  )
}

export async function startSlackStream({
  channel,
  chunks,
  recipientTeamId,
  recipientUserId,
  threadTs,
}: {
  channel: string
  chunks: SlackStreamChunk[]
  recipientTeamId: string
  recipientUserId: string
  threadTs: string
}): Promise<SlackPostMessage> {
  const parsed = z.array(SlackStreamChunkSchema).min(1).max(50).parse(chunks)
  return SlackPostMessageSchema.parse(
    await slackFetch("chat.startStream", {
      channel,
      chunks: parsed,
      recipient_team_id: recipientTeamId,
      recipient_user_id: recipientUserId,
      task_display_mode: "plan",
      thread_ts: threadTs,
    })
  )
}

export async function appendSlackStream({
  channel,
  chunks,
  ts,
}: {
  channel: string
  chunks: SlackStreamChunk[]
  ts: string
}): Promise<void> {
  const parsed = z.array(SlackStreamChunkSchema).min(1).max(50).parse(chunks)
  SlackPostMessageSchema.parse(
    await slackFetch("chat.appendStream", {
      channel,
      chunks: parsed,
      ts,
    })
  )
}

export async function stopSlackStream({
  channel,
  chunks,
  sessionStatus = "active",
  ts,
}: {
  channel: string
  chunks?: SlackStreamChunk[]
  sessionStatus?: "active" | "closed" | "processing" | "suspended"
  ts: string
}): Promise<void> {
  const parsed = chunks
    ? z.array(SlackStreamChunkSchema).min(1).max(50).parse(chunks)
    : undefined
  SlackPostMessageSchema.parse(
    await slackFetch("chat.stopStream", {
      channel,
      chunks: parsed,
      session_status: sessionStatus,
      ts,
    })
  )
}

export async function downloadSlackFile(fileId: string): Promise<{
  bytes: Uint8Array
  mimeType: string
  name: string
}> {
  const info = SlackFileInfoSchema.parse(
    await slackFetch("files.info", { file: fileId })
  ).file
  const source = info.url_private_download ?? info.url_private
  if (!source) throw new Error("Slack did not provide a private file URL")
  const url = new URL(source)
  const slackHost =
    url.hostname === "slack-files.com" || url.hostname.endsWith(".slack.com")
  if (url.protocol !== "https:" || !slackHost)
    throw new Error("Slack returned an invalid private file URL")
  const credential = await slackCredential()
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${credential.token}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new Error(`Slack file download returned ${response.status}`)
  const declared = info.size ?? 0
  if (declared > 100 * 1024 * 1024)
    throw new Error("Slack attachment exceeds Mako's 100 MB limit")
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > 100 * 1024 * 1024)
    throw new Error("Slack attachment exceeds Mako's 100 MB limit")
  return {
    bytes,
    mimeType: info.mimetype ?? response.headers.get("content-type") ?? "application/octet-stream",
    name: info.name ?? info.title ?? fileId,
  }
}

export async function uploadSlackFile({
  bytes,
  channel,
  filename,
  initialComment,
  threadTs,
  title,
}: {
  bytes: Uint8Array
  channel: string
  filename: string
  initialComment?: string
  threadTs: string
  title?: string
}): Promise<void> {
  const upload = SlackUploadUrlSchema.parse(
    await slackFetch("files.getUploadURLExternal", {
      filename,
      length: bytes.byteLength,
    })
  )
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const body = new FormData()
  body.set("file", new Blob([buffer]), filename)
  const uploaded = await fetch(upload.upload_url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(60_000),
  })
  if (!uploaded.ok)
    throw new Error(`Slack file upload returned ${uploaded.status}`)
  SlackOkSchema.parse(
    await slackFetch("files.completeUploadExternal", {
      channel_id: channel,
      files: [{ id: upload.file_id, title: title ?? filename }],
      initial_comment: initialComment,
      thread_ts: threadTs,
    })
  )
}
