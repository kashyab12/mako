import { after } from "next/server"
import { prepareSlackRelayWebhook } from "../../../../src/relay/slack-ingress"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const prepared = await prepareSlackRelayWebhook(request)
  if (prepared.run) after(prepared.run)
  return prepared.response
}
