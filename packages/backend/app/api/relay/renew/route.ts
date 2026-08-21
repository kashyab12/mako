import { z } from "zod"
import { relayAuthorized, relayUnauthorized } from "../../../../src/relay/auth"
import { renewRelayLease } from "../../../../src/relay/storage"
import { RelayRenewalSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  if (!relayAuthorized(request)) return relayUnauthorized()
  const renewal = RelayRenewalSchema.parse(z.json().parse(await request.json()))
  return Response.json({
    popReceipt: await renewRelayLease(renewal),
  })
}
