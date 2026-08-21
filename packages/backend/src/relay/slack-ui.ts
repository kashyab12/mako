import { getToken } from "@vercel/connect"
import {
  cardToSlackBlocks,
  type SlackCardElement,
} from "@chat-adapter/slack/blocks"
import { postSlackMessage } from "@chat-adapter/slack/api"
import { readOptionalServerEnv } from "../config/env"

const card: SlackCardElement = {
  type: "card",
  title: "Mako",
  subtitle: "Control the harnesses running on your Mac",
  children: [
    {
      type: "section",
      children: [
        {
          type: "text",
          content:
            "Ask a question normally to continue this Slack thread, or use the controls below. Work stays queued while your Mac is offline.",
        },
      ],
    },
    {
      type: "actions",
      children: [
        {
          type: "select",
          id: "mako-harness",
          label: "Harness",
          placeholder: "Choose harness",
          options: [
            { label: "Codex", value: "codex" },
            { label: "Claude Code", value: "claude" },
            { label: "Cursor", value: "cursor" },
            { label: "Grok", value: "grok" },
          ],
        },
        {
          type: "select",
          id: "mako-reasoning",
          label: "Reasoning",
          placeholder: "Reasoning effort",
          options: [
            { label: "Low", value: "low" },
            { label: "Medium", value: "medium" },
            { label: "High", value: "high" },
            { label: "Extra high", value: "xhigh" },
          ],
        },
      ],
    },
    {
      type: "actions",
      children: [
        { type: "button", id: "mako-fast-on", label: "Fast on", value: "on" },
        { type: "button", id: "mako-fast-off", label: "Fast off", value: "off" },
        { type: "button", id: "mako-status", label: "Status" },
        { type: "button", id: "mako-threads", label: "Threads" },
        { type: "button", id: "mako-models", label: "Models" },
      ],
    },
  ],
}

function connector(): string {
  return readOptionalServerEnv().SLACK_CONNECTOR ?? "slack/mako"
}

export function slackControlBlocks() {
  return cardToSlackBlocks(card)
}

export async function postSlackControls({
  channel,
  threadTs,
}: {
  channel: string
  threadTs?: string
}): Promise<string> {
  const posted = await postSlackMessage({
    blocks: slackControlBlocks(),
    channel,
    text: "Mako local harness controls",
    threadTs,
    token: () =>
      getToken(connector(), {
        subject: { type: "app" },
        scopes: ["*"],
      }),
    unfurlLinks: false,
    unfurlMedia: false,
  })
  return posted.id
}
