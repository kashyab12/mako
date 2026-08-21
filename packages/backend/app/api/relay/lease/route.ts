import { z } from "zod"
import { readServerEnv } from "../../../../src/config/env"
import { relayAuthorized, relayUnauthorized } from "../../../../src/relay/auth"
import { deliverRelayCompletion } from "../../../../src/relay/delivery"
import {
  heartbeatWorker,
  leaseRelayJob,
} from "../../../../src/relay/storage"
import { RelayLeaseRequestSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const maxDuration = 30
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  if (!relayAuthorized(request)) return relayUnauthorized()
  const input = RelayLeaseRequestSchema.parse(z.json().parse(await request.json()))
  await heartbeatWorker({
    heartbeat: input,
    teamId: z.string().min(1).parse(readServerEnv().SLACK_TEAM_ID),
  })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await leaseRelayJob(input)
    if (result.kind === "empty") return Response.json(result)
    if (result.kind === "work") {
      return Response.json({ kind: "job", lease: result.lease })
    }
    await deliverRelayCompletion({
      completion: result.completion,
      payload: result.payload,
    })
  }
  return Response.json({ kind: "empty" })
}
