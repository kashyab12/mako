import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
  SlackChannelIdSchema,
  SlackTimestampSchema,
  listSlackChannels,
  readSlackMessages,
  readSlackThread,
  sendSlackMessage,
  slackIdentity,
} from "../../integrations/slack/client"
import { textResult } from "../result"

const CursorSchema = z.string().max(512).optional()
const LimitSchema = z.number().int().min(1).max(100).default(50)

export function registerSlackTools(server: McpServer): void {
  server.registerTool(
    "mako_slack_status",
    {
      title: "Slack connection status",
      description:
        "Verify Mako's Vercel Connect Slack installation and return non-secret workspace identity.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => textResult(JSON.stringify(await slackIdentity(), null, 2))
  )

  server.registerTool(
    "mako_slack_list_channels",
    {
      title: "List Slack conversations",
      description:
        "List bounded Slack channels and conversations visible to the installed Mako app.",
      inputSchema: z.object({
        cursor: CursorSchema,
        limit: LimitSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ cursor, limit }) =>
      textResult(
        JSON.stringify(await listSlackChannels({ cursor, limit }), null, 2)
      )
  )

  server.registerTool(
    "mako_slack_read_messages",
    {
      title: "Read Slack messages",
      description:
        "Read a bounded page of recent messages from one exact Slack conversation.",
      inputSchema: z.object({
        channel: SlackChannelIdSchema,
        cursor: CursorSchema,
        limit: LimitSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ channel, cursor, limit }) =>
      textResult(
        JSON.stringify(
          await readSlackMessages({ channel, cursor, limit }),
          null,
          2
        )
      )
  )

  server.registerTool(
    "mako_slack_read_thread",
    {
      title: "Read a Slack thread",
      description:
        "Read a bounded page of replies from one exact Slack conversation thread.",
      inputSchema: z.object({
        channel: SlackChannelIdSchema,
        cursor: CursorSchema,
        limit: LimitSchema,
        threadTs: SlackTimestampSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ channel, cursor, limit, threadTs }) =>
      textResult(
        JSON.stringify(
          await readSlackThread({ channel, cursor, limit, threadTs }),
          null,
          2
        )
      )
  )

  server.registerTool(
    "mako_slack_send_message",
    {
      title: "Send a Slack message",
      description:
        "Send one message to an exact Slack destination. Requires an idempotency key so retries cannot duplicate the message.",
      inputSchema: z.object({
        channel: SlackChannelIdSchema,
        idempotencyKey: z.uuid(),
        text: z.string().min(1).max(4_000),
        threadTs: SlackTimestampSchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ channel, idempotencyKey, text, threadTs }) =>
      textResult(
        JSON.stringify(
          await sendSlackMessage({
            channel,
            idempotencyKey,
            text,
            threadTs,
          }),
          null,
          2
        )
      )
  )
}
