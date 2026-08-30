import { z } from "zod"
import { readServerEnv } from "../../../../src/config/env"
import {
  relayRegistrationAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { azureRelayStore } from "../../../../src/relay/azure-store"
import { RelayHarnessSchema } from "../../../../src/relay/types"

const RequestSchema = z.object({
  deviceId: z.uuid(),
  deviceName: z.string().min(1).max(160),
  defaultHarness: RelayHarnessSchema,
  defaultModel: z.string().min(1).max(160).optional(),
  tenantId: z.string().min(1).max(80).optional(),
})

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  if (!relayRegistrationAuthorized(request)) return relayUnauthorized()
  const input = RequestSchema.parse(z.json().parse(await request.json()))
  const tenantId = readServerEnv().SLACK_TEAM_ID
  if (!tenantId || (input.tenantId && input.tenantId !== tenantId))
    return relayUnauthorized()
  const deviceSecret = await azureRelayStore.registerDevice({
    ...input,
    tenantId,
  })
  return Response.json({ tenantId, deviceId: input.deviceId, deviceSecret })
}
