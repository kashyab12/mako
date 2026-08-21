import { handleSlackRelayWebhook } from "../../../../src/relay/slack-ingress"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export function POST(request: Request): Promise<Response> {
  return handleSlackRelayWebhook(request)
}
