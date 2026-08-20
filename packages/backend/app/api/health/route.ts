import { readOptionalServerEnv } from "../../../src/config/env"
import { backendStatus } from "../../../src/status"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export function GET(): Response {
  return Response.json(backendStatus(readOptionalServerEnv()), {
    headers: {
      "Cache-Control": "no-store",
    },
  })
}
