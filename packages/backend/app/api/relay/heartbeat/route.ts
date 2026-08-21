import { z } from "zod"
import { readServerEnv } from "../../../../src/config/env"
import { relayAuthorized, relayUnauthorized } from "../../../../src/relay/auth"
import { heartbeatWorker } from "../../../../src/relay/storage"
import { WorkerHeartbeatSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  if (!relayAuthorized(request)) return relayUnauthorized()
  const heartbeat = WorkerHeartbeatSchema.parse(
    z.json().parse(await request.json())
  )
  await heartbeatWorker({
    heartbeat,
    teamId: z.string().min(1).parse(readServerEnv().SLACK_TEAM_ID),
  })
  return Response.json({ ok: true })
}
