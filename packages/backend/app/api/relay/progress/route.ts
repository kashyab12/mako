import { z } from "zod"
import { deliverRelayProgress } from "../../../../src/relay/delivery"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { RelayProgressSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const progress = RelayProgressSchema.parse(z.json().parse(await request.json()))
  if (!relayDeviceAuthorized(auth, progress.deviceId)) return relayUnauthorized()
  return Response.json({ accepted: await deliverRelayProgress(progress) })
}
