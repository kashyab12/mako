# Run your own Mako Slack bot

Mako does not require the project’s Slack app. You can create a Slack app in
your workspace, deploy the open-source backend, and point the desktop app at
that deployment.

```text
Slack → your Mako backend → durable Azure queue → your Mac → local agent CLI
```

The backend never runs a model. It verifies Slack, queues work while the Mac is
offline, and returns the local harness result to the same Slack thread.

## 1. Create the Slack app

Create an app from scratch in the Slack workspace you control.

Add these bot scopes:

- `app_mentions:read`
- `channels:history`
- `chat:write`
- `commands`
- `groups:history`
- `im:history`
- `mpim:history`

Enable Event Subscriptions and subscribe to `app_mention`, `message.channels`,
`message.groups`, `message.im`, and `message.mpim`. Set the Request URL to:

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
3. Send `new codex Reply with exactly OK`.
4. Quit Mako, send another request, reopen Mako, and confirm the queued request
   completes in the same Slack thread.

Useful commands include `threads`, `resume`, `new`, `harness`, `models`,
`model`, `reasoning`, `fast`, `status`, and `help`.

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

- Slack requests use Slack’s timestamped `v0` HMAC verification.
- Direct bot tokens and signing secrets stay server-side.
- The desktop backend token stays in Keychain.
- Azure credentials stay in the backend environment.
- Allowlist Slack users explicitly; do not expose a public unrestricted bot.
- Local browser and computer tools remain local and are not provided by the
  backend.
