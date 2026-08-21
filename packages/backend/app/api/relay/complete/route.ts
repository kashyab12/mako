import { z } from "zod"
import { relayAuthorized, relayUnauthorized } from "../../../../src/relay/auth"
import { deliverRelayCompletion } from "../../../../src/relay/delivery"
import { recordRelayCompletion } from "../../../../src/relay/storage"
import { RelayCompletionSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  if (!relayAuthorized(request)) return relayUnauthorized()
  const completion = RelayCompletionSchema.parse(
    z.json().parse(await request.json())
  )
  const payload = await recordRelayCompletion(completion)
  await deliverRelayCompletion({ completion, payload })
  return Response.json({ ok: true })
}
