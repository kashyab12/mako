import { z } from "zod"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { azureRelayStore } from "../../../../src/relay/azure-store"
import { WorkerHeartbeatSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const heartbeat = WorkerHeartbeatSchema.parse(
    z.json().parse(await request.json())
  )
  if (!relayDeviceAuthorized(auth, heartbeat.deviceId))
    return relayUnauthorized()
  await azureRelayStore.heartbeat(auth.tenantId, heartbeat)
  await azureRelayStore.reconcile(auth.tenantId)
  return Response.json({ ok: true })
}
