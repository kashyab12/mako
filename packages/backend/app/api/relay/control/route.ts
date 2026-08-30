import { z } from "zod"
import { relayAuthorized, relayUnauthorized } from "../../../../src/relay/auth"
import { relayControl } from "../../../../src/relay/storage"
import { RelayControlPollSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  if (!relayAuthorized(request)) return relayUnauthorized()
  const input = RelayControlPollSchema.parse(z.json().parse(await request.json()))
  return Response.json({ control: await relayControl(input) })
}
