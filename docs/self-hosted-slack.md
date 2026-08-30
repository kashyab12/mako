# Run your own Mako Slack bot

Mako does not require the project’s Slack app. You can create a Slack app in
your workspace, deploy the open-source backend, and point the desktop app at
that deployment.

```text
Slack Agent view → your Mako backend → durable Azure queue → your worker → local agent CLI
```

The backend never runs a model. It verifies Slack, queues work while the worker
is offline, streams live output and task state into the same Slack thread, and
returns generated files without exposing the Slack token to the worker.

## 1. Create the Slack app

Create an app from scratch in the Slack workspace you control.

Enable Slack’s **Agent** feature and use the `agent_view` messaging experience.
Add these bot scopes:

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `chat:write`
- `commands`
- `files:read`
- `files:write`
- `groups:history`
- `im:history`
- `mpim:history`

Enable Event Subscriptions and subscribe to `agent_session_stopped`,
`app_context_changed`, `app_home_opened`, `app_mention`, `message.channels`,
`message.groups`, `message.im`, and `message.mpim`. The stop subscription is what
turns Slack’s processing indicator into a native Stop button. Set the Request URL to:

```text
https://YOUR_BACKEND/api/slack/events
```

Use the same URL for Interactivity. Optionally add a `/mako` slash command with
that Request URL. Install the app, then copy its bot token and signing secret.

## 2. Provision the durable relay

Create an Azure Storage account and a service principal scoped to that account.
The backend uses Queue Storage for durable jobs and Table Storage for Slack
thread mappings and worker heartbeats.

Copy the backend environment template:

```bash
cp packages/backend/.env.example packages/backend/.env.local
```

Set:

```dotenv
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_STORAGE_ACCOUNT_NAME=...
AZURE_TENANT_ID=...
MAKO_MCP_TOKEN=generate-at-least-32-random-characters
SLACK_ALLOWED_USER_IDS=U01234567
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_TEAM_ID=T01234567
```

`SLACK_ALLOWED_USER_IDS` is a comma-separated allowlist. Mako rejects events
from every other user even when the Slack signature is valid.

Deploy `packages/backend` to any platform that runs Next.js route handlers. The
included Vercel deployment remains one option, not a requirement. If you prefer
Vercel Connect, leave `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` empty and set
`SLACK_CONNECTOR` instead.

## 3. Connect the Mac

Point the desktop process at your backend and store the matching MCP token in
macOS Keychain:

```bash
security add-generic-password -U \
  -s dev.mako.backend.mcp \
  -a "$USER" \
  -w 'YOUR_MAKO_MCP_TOKEN'

MAKO_BACKEND_URL=https://YOUR_BACKEND/api/mcp npm run desktop
```

Packaged builds can be launched with `MAKO_BACKEND_URL` from a wrapper or MDM
profile. The token remains in Keychain and never crosses the renderer bridge.

## 4. Verify it

1. Open Mako and confirm **Settings → Integrations → Mako Backend** is ready.
2. Mention the bot in Slack and send `status`.
3. Send `new codex Reply with exactly OK` and confirm Slack shows the native
   processing state, Stop button, plan/task card, and streamed answer.
4. Send two messages quickly and confirm the second remains queued for the same
   local session.
5. Attach an image or file and confirm the local agent receives a staged path.
6. Ask the agent to create a file and confirm it returns in the Slack thread.
7. Quit Mako, send another request, reopen Mako, and confirm the queued request
   completes in the same Slack thread.

Useful commands include `threads`, `resume`, `new`, `queue`, `steer`, `stop`,
`harness`, `models`, `model`, `reasoning`, `fast`, `status`, and `help`. Plain
messages resume the session mapped to that Slack thread; while it is working,
plain messages queue in arrival order. `steer` stops the current native turn and
puts the new message next rather than pretending every provider can steer live.

## Operations and troubleshooting

- `401 Unauthorized` on the event URL means the signing secret or Slack clock
  skew is wrong. Mako deliberately returns no more detail to Slack.
- `status` reporting the Mac offline means the backend is healthy but no desktop
  heartbeat is current. Check `MAKO_BACKEND_URL` and the Keychain token.
- A queued request that never leases usually means the Azure service principal
  cannot access Queue or Table Storage.
- Rotate the bot token and signing secret in Slack, update both backend
  variables together, then redeploy. Partial direct credentials are rejected at
  startup rather than silently falling back.
- Back up the Azure tables if Slack-to-session lineage matters to you. Queue
  messages are transient work, not conversation history; provider sessions stay
  on the Mac.
- Azure Storage usage is typically small, but it is your account and billing
  boundary. Configure the budget and monitoring appropriate for your deployment.

## Security notes

- This self-hosted deployment is intentionally single-tenant: one Slack
  workspace and one worker credential boundary. The reserved tenant/device IDs
  are not a claim of cloud multi-tenancy.
- Slack requests use Slack’s timestamped `v0` HMAC verification.
- Direct bot tokens and signing secrets stay server-side.
- The desktop backend token stays in Keychain.
- Azure credentials stay in the backend environment.
- Allowlist Slack users explicitly; do not expose a public unrestricted bot.
- Slack bot tokens remain server-side. Workers fetch only attachment bytes that
  belong to their claimed job through the authenticated relay.
- Incoming files are bounded to 100 MB each and 200 MB per job, staged with
  owner-only permissions, and removed when the run settles.
- Outgoing files are limited to five files, 25 MB each, and must resolve inside
  the active workspace; symlinks cannot escape that boundary.
- Local browser and computer tools remain local and are not provided by the
  backend.
