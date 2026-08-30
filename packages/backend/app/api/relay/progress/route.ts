import { z } from "zod"
import { deliverRelayProgress } from "../../../../src/relay/delivery"
import { relayAuthorized, relayUnauthorized } from "../../../../src/relay/auth"
import { RelayProgressSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  if (!relayAuthorized(request)) return relayUnauthorized()
  const progress = RelayProgressSchema.parse(z.json().parse(await request.json()))
  return Response.json({ accepted: await deliverRelayProgress(progress) })
}
