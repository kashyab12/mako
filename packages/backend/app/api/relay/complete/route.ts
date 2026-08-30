import { z } from "zod"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { deliverRelayCompletion } from "../../../../src/relay/delivery"
import { azureRelayStore } from "../../../../src/relay/azure-store"
import { RelayCompletionSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const completion = RelayCompletionSchema.parse(
    z.json().parse(await request.json())
  )
  if (!relayDeviceAuthorized(auth, completion.deviceId))
    return relayUnauthorized()
  const payload = await azureRelayStore.recordCompletion(completion)
  await deliverRelayCompletion({ completion, payload })
  return Response.json({ ok: true })
}
