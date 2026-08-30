import {
  RelayTokenRequestSchema,
  signRelayToken,
  verifyRelayToken,
  verifyRelayTokenRequestKey,
  type RelayTokenRequest,
  type RelayTokenResponse,
} from "@mako/relay"
import { readServerEnv } from "../config/env"
import { verifyMcpToken } from "../mcp/auth"

export type RelayAuth =
  | { kind: "device"; tenantId: string; deviceId: string }
  | { kind: "legacy"; tenantId: string }

function bearer(request: Request): string | null {
  return /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null
}

export function relayAuth(request: Request): RelayAuth | null {
  const token = bearer(request)
  if (!token) return null
  const environment = readServerEnv()
  const tenantId = environment.SLACK_TEAM_ID
  if (!tenantId) return null
  if (environment.RELAY_TOKEN_SECRET) {
    const claims = verifyRelayToken(token, environment.RELAY_TOKEN_SECRET)
    if (
      claims?.tenantId === tenantId &&
      claims.scopes.includes("relay:read") &&
      claims.scopes.includes("relay:write")
    )
      return { kind: "device", tenantId, deviceId: claims.deviceId }
  }
  const legacyAllowed =
    !environment.RELAY_TOKEN_SECRET ||
    environment.RELAY_ALLOW_LEGACY_TOKEN === "true"
  return legacyAllowed && verifyMcpToken(request, token)
    ? { kind: "legacy", tenantId }
    : null
}

export function relayDeviceAuthorized(
  auth: RelayAuth,
  deviceId: string
): boolean {
  return auth.kind === "legacy" || auth.deviceId === deviceId
}

export function relayRegistrationAuthorized(request: Request): boolean {
  const environment = readServerEnv()
  const bootstrap = request.headers.get("X-Mako-Relay-Bootstrap")
  if (
    bootstrap &&
    environment.RELAY_BOOTSTRAP_SECRET &&
    bootstrap === environment.RELAY_BOOTSTRAP_SECRET
  )
    return true
  const token = bearer(request)
  return Boolean(token && verifyMcpToken(request, token))
}

export function issueRelayToken({
  deviceKey,
  request,
}: {
  deviceKey: Buffer
  request: RelayTokenRequest
}): RelayTokenResponse | null {
  const environment = readServerEnv()
  if (
    !environment.RELAY_TOKEN_SECRET ||
    request.tenantId !== environment.SLACK_TEAM_ID ||
    !verifyRelayTokenRequestKey(request, deviceKey)
  )
    return null
  const issuedAt = Math.floor(Date.now() / 1_000)
  const expiresAt = issuedAt + 5 * 60
  return {
    token: signRelayToken(
      {
        version: 1,
        tenantId: request.tenantId,
        deviceId: request.deviceId,
        scopes: ["relay:read", "relay:write"],
        issuedAt,
        expiresAt,
      },
      environment.RELAY_TOKEN_SECRET
    ),
    expiresAt,
  }
}

export function parseRelayTokenRequest<Value>(value: Value): RelayTokenRequest {
  return RelayTokenRequestSchema.parse(value)
}

export function relayUnauthorized(): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    }
  )
}
