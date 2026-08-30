import { createHmac, timingSafeEqual } from "node:crypto"
import {
  RelayTokenClaimsSchema,
  type RelayTokenClaims,
  type RelayTokenRequest,
} from "./schema.js"

function signature(value: string, secret: string | Buffer): Buffer {
  return createHmac("sha256", secret).update(value).digest()
}

export function relayDeviceKey(deviceSecret: string): Buffer {
  return createHmac("sha256", "mako-relay-device-v1")
    .update(deviceSecret)
    .digest()
}

function equalSignature(encoded: string, expected: Buffer): boolean {
  let actual: Buffer
  try {
    actual = Buffer.from(encoded, "base64url")
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function relayTokenRequestValue(
  request: Pick<RelayTokenRequest, "tenantId" | "deviceId" | "nonce" | "timestamp">
): string {
  return `${request.tenantId}\0${request.deviceId}\0${request.nonce}\0${request.timestamp}`
}

export function signRelayTokenRequest(
  request: Pick<RelayTokenRequest, "tenantId" | "deviceId" | "nonce" | "timestamp">,
  deviceSecret: string
): string {
  return signature(
    relayTokenRequestValue(request),
    relayDeviceKey(deviceSecret)
  ).toString(
    "base64url"
  )
}

export function verifyRelayTokenRequest(
  request: RelayTokenRequest,
  deviceSecret: string,
  now = Date.now()
): boolean {
  return verifyRelayTokenRequestKey(
    request,
    relayDeviceKey(deviceSecret),
    now
  )
}

export function verifyRelayTokenRequestKey(
  request: RelayTokenRequest,
  deviceKey: Buffer,
  now = Date.now()
): boolean {
  if (Math.abs(now - request.timestamp) > 5 * 60_000) return false
  return equalSignature(
    request.signature,
    signature(relayTokenRequestValue(request), deviceKey)
  )
}

export function signRelayToken(
  claims: RelayTokenClaims,
  tokenSecret: string
): string {
  const body = Buffer.from(
    JSON.stringify(RelayTokenClaimsSchema.parse(claims))
  ).toString("base64url")
  const mac = signature(`v1.${body}`, tokenSecret).toString("base64url")
  return `v1.${body}.${mac}`
}

export function verifyRelayToken(
  token: string,
  tokenSecret: string,
  now = Date.now()
): RelayTokenClaims | null {
  const [version, body, mac, extra] = token.split(".")
  if (version !== "v1" || !body || !mac || extra) return null
  if (!equalSignature(mac, signature(`v1.${body}`, tokenSecret))) return null
  try {
    const claims = RelayTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    )
    const seconds = Math.floor(now / 1_000)
    if (claims.issuedAt > seconds + 30 || claims.expiresAt <= seconds) return null
    return claims
  } catch {
    return null
  }
}
