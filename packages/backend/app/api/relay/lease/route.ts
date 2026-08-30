import { z } from "zod"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import {
  deliverRelayCompletion,
  startRelayDelivery,
} from "../../../../src/relay/delivery"
import { azureRelayStore } from "../../../../src/relay/azure-store"
import { RelayLeaseRequestSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const input = RelayLeaseRequestSchema.parse(z.json().parse(await request.json()))
  if (!relayDeviceAuthorized(auth, input.deviceId)) return relayUnauthorized()
  await azureRelayStore.heartbeat(auth.tenantId, input)
  await azureRelayStore.reconcile(auth.tenantId)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await azureRelayStore.lease({
      tenantId: auth.tenantId,
      deviceId: input.deviceId,
      visibilityTimeoutSeconds: input.visibilityTimeoutSeconds,
    })
    if (result.kind === "empty") return Response.json(result)
    if (result.kind === "work") {
      await startRelayDelivery({
        defaultHarness: input.defaultHarness,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        lease: result.lease,
      })
      return Response.json({ kind: "job", lease: result.lease })
    }
    await deliverRelayCompletion({
      completion: result.completion,
      payload: result.payload,
    })
  }
  return Response.json({ kind: "empty" })
}
