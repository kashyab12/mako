import { RelayEventBatchSchema } from "@mako/relay"
import { z } from "zod"
import { deliverRelayEvents } from "../../../../src/relay/delivery"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const batch = RelayEventBatchSchema.parse(z.json().parse(await request.json()))
  if (!relayDeviceAuthorized(auth, batch.deviceId)) return relayUnauthorized()
  return Response.json({ delivered: await deliverRelayEvents(batch) })
}
