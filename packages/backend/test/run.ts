import assert from "node:assert/strict"
import { z } from "zod"
import { integrationCatalog } from "../src/integrations/catalog"
import { formatHarnessReplies } from "../src/relay/delivery"
import { parseSlackRelayCommand } from "../src/relay/commands"
import { listSkills, readSkill } from "../src/skills/catalog"
import { backendStatus } from "../src/status"

const token = "mako-test-token-".padEnd(64, "x")
process.env.MAKO_MCP_TOKEN = token
process.env.VERCEL_ENV = "development"

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

const slack = {
  channel: "CTEST",
  eventId: "event-1",
  teamId: "TTEST",
  threadTs: "123.456",
  userId: "UTEST",
}
assert.equal(
  parseSlackRelayCommand({ mapping: null, slack, text: "new codex investigate" })
    .kind,
  "enqueue"
)
const continuation = parseSlackRelayCommand({
  mapping: {
    harness: "claude",
    model: "sonnet",
    threadPath: "/tmp/thread",
  },
  slack,
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
    slack,
    text,
  })
  assert.equal(command.kind, "enqueue")
  if (command.kind === "enqueue") {
    assert.equal(command.payload.kind, "configure")
    assert.equal(command.payload.selection[field], value)
  }
}
assert.equal(
  parseSlackRelayCommand({ mapping: null, slack, text: "threads auth" }).kind,
  "enqueue"
)
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
