import { z } from "zod"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { azureRelayStore } from "../../../../src/relay/azure-store"
import { RelayControlPollSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const input = RelayControlPollSchema.parse(z.json().parse(await request.json()))
  if (!relayDeviceAuthorized(auth, input.deviceId)) return relayUnauthorized()
  return Response.json({ control: await azureRelayStore.control(input) })
}
