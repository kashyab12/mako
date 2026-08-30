import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { parseSlackWebhookBody } from "@chat-adapter/slack/webhook"
import { z } from "zod"
import { readOptionalServerEnv } from "../src/config/env"
import { integrationCatalog } from "../src/integrations/catalog"
import { slackIdentity } from "../src/integrations/slack/client"
import { formatHarnessReplies } from "../src/relay/delivery"
import { parseSlackRelayCommand } from "../src/relay/commands"
import {
  prepareSlackRelayWebhook,
  slackActionCommand,
} from "../src/relay/slack-ingress"
import {
  postSlackControls,
  slackControlBlocks,
} from "../src/relay/slack-ui"
import { listSkills, readSkill } from "../src/skills/catalog"
import { backendStatus } from "../src/status"

const token = "mako-test-token-".padEnd(64, "x")
process.env.MAKO_MCP_TOKEN = token
process.env.VERCEL_ENV = "development"
delete process.env.SLACK_BOT_TOKEN
delete process.env.SLACK_SIGNING_SECRET

const { makoMcpHandler } = await import("../src/mcp/server")

function mcpRequest(
  method: string,
  params: z.input<typeof JsonRpcParamsSchema>,
  bearerToken = token
): Request {
  const validatedParams = JsonRpcParamsSchema.parse(params)
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: validatedParams,
    }),
  })
}

const JsonRpcParamsSchema = z.record(z.string(), z.json())
const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.json().optional(),
  error: z.json().optional(),
})

async function jsonRpc(response: Response) {
  const text = await response.text()
  const payload = text.startsWith("event:")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text
  assert.ok(payload)
  const body = JsonRpcResponseSchema.parse(JSON.parse(payload))
  assert.equal(response.status, 200)
  assert.equal(body.error, undefined)
  return body.result
}

function signedSlackRequest(
  body: string,
  signingSecret: string,
  timestamp = Math.floor(Date.now() / 1_000)
): Request {
  const timestampHeader = timestamp.toString()
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestampHeader}:${body}`)
    .digest("hex")
  return new Request("http://localhost:3000/api/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestampHeader,
      "X-Slack-Signature": `v0=${signature}`,
    },
    body,
  })
}

const unauthorized = await makoMcpHandler(
  mcpRequest(
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
    "wrong-token".padEnd(64, "x")
  )
)
assert.equal(unauthorized.status, 401)

await jsonRpc(
  await makoMcpHandler(
    mcpRequest("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    })
  )
)

const tools = await jsonRpc(
  await makoMcpHandler(mcpRequest("tools/list", {}))
)
const serializedTools = JSON.stringify(tools)
for (const name of [
  "mako_server_status",
  "mako_list_integrations",
  "mako_list_skills",
  "mako_read_skill",
  "mako_slack_status",
  "mako_slack_list_channels",
  "mako_slack_read_messages",
  "mako_slack_read_thread",
  "mako_slack_send_message",
]) {
  assert.match(serializedTools, new RegExp(name))
}

const resources = await jsonRpc(
  await makoMcpHandler(mcpRequest("resources/list", {}))
)
assert.match(JSON.stringify(resources), /mako:\/\/skills\/mako-operations/)

const skill = await readSkill("mako-operations")
assert.match(skill, /Mako operations/)
assert.equal(listSkills().length, 1)

const connected = integrationCatalog({ slackConnected: true })
assert.equal(connected[0]?.status.kind, "connected")
const disconnected = integrationCatalog({ slackConnected: false })
assert.equal(disconnected[0]?.status.kind, "available")

const origin = {
  provider: "slack",
  tenantId: "TTEST",
  conversationId: "CTEST",
  threadId: "123.456",
  eventId: "event-1",
  userId: "UTEST",
}
assert.equal(
  parseSlackRelayCommand({ mapping: null, origin, text: "new codex investigate" })
    .kind,
  "enqueue"
)
const continuation = parseSlackRelayCommand({
  mapping: {
    harness: "claude",
    model: "sonnet",
    threadPath: "/tmp/thread",
  },
  origin,
  text: "continue",
})
assert.equal(continuation.kind, "enqueue")
if (continuation.kind === "enqueue") {
  assert.equal(continuation.payload.kind, "resume")
}
for (const [text, field, value] of [
  ["reasoning high", "effort", "high"],
  ["fast on", "fast", true],
  ["model gpt-5.6", "model", "gpt-5.6"],
  ["harness codex", "harness", "codex"],
] satisfies Array<
  [string, "effort" | "fast" | "model" | "harness", string | boolean]
>) {
  const command = parseSlackRelayCommand({
    mapping: {
      harness: "claude",
      model: "sonnet",
      threadPath: "/tmp/thread",
    },
    origin,
    text,
  })
  assert.equal(command.kind, "enqueue")
  if (command.kind === "enqueue") {
    assert.equal(command.payload.kind, "configure")
    assert.equal(command.payload.selection[field], value)
  }
}
assert.equal(
  parseSlackRelayCommand({ mapping: null, origin, text: "threads auth" }).kind,
  "enqueue"
)
const attachmentCommand = parseSlackRelayCommand({
  attachments: [
    {
      id: "FTEST",
      kind: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      size: 1_024,
    },
  ],
  mapping: null,
  origin,
  text: "",
})
assert.equal(attachmentCommand.kind, "enqueue")
if (attachmentCommand.kind === "enqueue") {
  assert.equal(attachmentCommand.payload.kind, "new")
  if (attachmentCommand.payload.kind === "new") {
    assert.equal(attachmentCommand.payload.attachments[0]?.id, "FTEST")
  }
}
const futureHarness = parseSlackRelayCommand({
  mapping: null,
  origin,
  text: "new future-agent investigate",
})
assert.equal(futureHarness.kind, "enqueue")
if (futureHarness.kind === "enqueue")
  assert.equal(futureHarness.payload.selection.harness, "future-agent")

const directBotToken = "xoxb-test-direct-bot-token"
const directSigningSecret = "0123456789abcdef0123456789abcdef"
assert.throws(
  () =>
    readOptionalServerEnv({
      MAKO_MCP_TOKEN: token,
      NODE_ENV: "test",
      SLACK_BOT_TOKEN: directBotToken,
    }),
  /must be configured together/
)
process.env.SLACK_BOT_TOKEN = directBotToken
process.env.SLACK_SIGNING_SECRET = directSigningSecret

const challengeBody = JSON.stringify({
  challenge: "self-hosted-challenge",
  token: "legacy-verification-token",
  type: "url_verification",
})
const directWebhook = await prepareSlackRelayWebhook(
  signedSlackRequest(challengeBody, directSigningSecret)
)
assert.equal(directWebhook.response.status, 200)
assert.deepEqual(await directWebhook.response.json(), {
  challenge: "self-hosted-challenge",
})
const invalidDirectWebhook = await prepareSlackRelayWebhook(
  signedSlackRequest(challengeBody, "fedcba9876543210fedcba9876543210")
)
assert.equal(invalidDirectWebhook.response.status, 401)
const staleDirectWebhook = await prepareSlackRelayWebhook(
  signedSlackRequest(
    challengeBody,
    directSigningSecret,
    Math.floor(Date.now() / 1_000) - 301
  )
)
assert.equal(staleDirectWebhook.response.status, 401)

const originalFetch = globalThis.fetch
let directSlackApiCalled = false
let directSlackControlsCalled = false
globalThis.fetch = async (input, init) => {
  const url = String(input)
  directSlackApiCalled ||= url === "https://slack.com/api/auth.test"
  directSlackControlsCalled ||= url === "https://slack.com/api/chat.postMessage"
  assert.equal(
    new Headers(init?.headers).get("authorization") === `Bearer ${directBotToken}`,
    true
  )
  if (url === "https://slack.com/api/chat.postMessage") {
    const body = z
      .object({ blocks: z.array(z.json()).min(1), channel: z.literal("CTEST") })
      .parse(JSON.parse(String(init?.body)))
    assert.ok(body.blocks.length > 0)
    return Response.json({
      ok: true,
      channel: "CTEST",
      ts: "123.456",
      message: { text: "Mako local harness controls" },
    })
  }
  return Response.json({
    ok: true,
    team: "Test Team",
    team_id: "TTEST",
    user: "mako-test",
    user_id: "UTESTBOT",
    bot_id: "BTEST",
  })
}
try {
  const identity = await slackIdentity()
  assert.equal(identity.team_id, "TTEST")
  assert.equal(directSlackApiCalled, true)
  assert.equal(await postSlackControls({ channel: "CTEST" }), "123.456")
  assert.equal(directSlackControlsCalled, true)
} finally {
  globalThis.fetch = originalFetch
}

delete process.env.SLACK_BOT_TOKEN
delete process.env.SLACK_SIGNING_SECRET
process.env.SLACK_CONNECTOR = "slack/mako-test-fallback"
const previousOidcToken = process.env.VERCEL_OIDC_TOKEN
const oidcPayload = Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })
).toString("base64url")
process.env.VERCEL_OIDC_TOKEN = `e30.${oidcPayload}.test-signature`
const connectorBotToken = "xoxb-test-connector-bot-token"
let connectorTokenRequested = false
let connectorSlackApiCalled = false
globalThis.fetch = async (input, init) => {
  const url = String(input)
  const headers = new Headers(init?.headers)
  if (
    url ===
    "https://api.vercel.com/v1/connect/token/slack%2Fmako-test-fallback"
  ) {
    connectorTokenRequested = true
    assert.equal(headers.get("authorization")?.startsWith("Bearer "), true)
    return Response.json({
      expiresAt: Date.now() + 60_000,
      token: connectorBotToken,
    })
  }
  connectorSlackApiCalled = url === "https://slack.com/api/auth.test"
  assert.equal(
    headers.get("authorization") === `Bearer ${connectorBotToken}`,
    true
  )
  return Response.json({
    ok: true,
    team: "Connector Team",
    team_id: "TCONNECT",
    user: "mako-connect-test",
    user_id: "UCONNECT",
    bot_id: "BCONNECT",
  })
}
try {
  const identity = await slackIdentity()
  assert.equal(identity.team_id, "TCONNECT")
  assert.equal(connectorTokenRequested, true)
  assert.equal(connectorSlackApiCalled, true)
} finally {
  globalThis.fetch = originalFetch
  if (previousOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN
  else process.env.VERCEL_OIDC_TOKEN = previousOidcToken
}

const unsignedSlack = await prepareSlackRelayWebhook(
  new Request("http://localhost:3000/api/slack/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
)
assert.equal(unsignedSlack.response.status, 401)

const slash = parseSlackWebhookBody(
  new URLSearchParams({
    channel_id: "CTEST",
    command: "/mako",
    team_id: "TTEST",
    text: "status",
    trigger_id: "trigger-1",
    user_id: "UTEST",
  }).toString(),
  { contentType: "application/x-www-form-urlencoded" }
)
assert.equal(slash.kind, "slash_command")
if (slash.kind === "slash_command") assert.equal(slash.text, "status")
const action = parseSlackWebhookBody(
  new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: "UTEST" },
      team: { id: "TTEST" },
      channel: { id: "CTEST" },
      message: { ts: "123.456", thread_ts: "123.456" },
      actions: [
        {
          action_id: "mako-harness",
          type: "static_select",
          selected_option: { value: "codex" },
        },
      ],
    }),
  }).toString(),
  { contentType: "application/x-www-form-urlencoded" }
)
assert.equal(action.kind, "block_actions")
if (action.kind === "block_actions") {
  assert.equal(slackActionCommand(action), "harness codex")
}
const controls = JSON.stringify(slackControlBlocks())
for (const actionId of [
  "mako-harness",
  "mako-reasoning",
  "mako-fast-on",
  "mako-status",
  "mako-threads",
  "mako-models",
]) {
  assert.match(controls, new RegExp(actionId))
}
assert.deepEqual(formatHarnessReplies("one\\n\\ntwo"), ["one\n\ntwo"])
assert.equal(formatHarnessReplies("x".repeat(24_000)).length, 3)
assert.deepEqual(backendStatus({}).relay, {
  execution: "local-harness",
  persistence: "azure-storage",
  offlineQueue: true,
})

assert.equal(JSON.stringify(tools).includes(token), false)
assert.equal(JSON.stringify(resources).includes(token), false)

console.log("Backend MCP auth, tools, resources, skills, and catalog checks passed")
