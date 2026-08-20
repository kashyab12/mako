import assert from "node:assert/strict"
import {
  listSlackChannels,
  slackIdentity,
} from "../src/integrations/slack/client"

const identity = await slackIdentity()
assert.equal(identity.ok, true)
assert.ok(identity.team_id)
assert.ok(identity.bot_id || identity.user_id)

const channels = await listSlackChannels({ limit: 1 })
assert.equal(channels.ok, true)
assert.ok(Array.isArray(channels.channels))

console.log("Live Vercel Connect Slack identity and channel access checks passed")
