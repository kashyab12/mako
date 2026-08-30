import { z } from "zod"
import {
  issueRelayToken,
  parseRelayTokenRequest,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { azureRelayStore } from "../../../../src/relay/azure-store"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const input = parseRelayTokenRequest(z.json().parse(await request.json()))
  const key = await azureRelayStore.deviceKey(input.tenantId, input.deviceId)
  if (!key) return relayUnauthorized()
  const response = issueRelayToken({ deviceKey: key, request: input })
  return response ? Response.json(response) : relayUnauthorized()
}
