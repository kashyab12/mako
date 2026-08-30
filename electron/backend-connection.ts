import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { userInfo } from "node:os"
import { promisify } from "node:util"
import {
  RelayRegistrationResponseSchema,
  RelayTokenResponseSchema,
  signRelayTokenRequest,
} from "@mako/relay"
import { z } from "zod"

const run = promisify(execFile)
const KEYCHAIN_SERVICE = "dev.mako.backend.mcp"
const RELAY_KEYCHAIN_SERVICE = "dev.mako.backend.relay"
const DEFAULT_URL = "https://mako-pearl.vercel.app/api/mcp"
let backendUrl = process.env.MAKO_BACKEND_URL ?? DEFAULT_URL
let backendToken = process.env.MAKO_BACKEND_TOKEN
let relayDevice:
  | { deviceId: string; deviceName: string; defaultHarness: string }
  | undefined
let relayCredential:
  | { tenantId: string; deviceSecret: string }
  | null
  | undefined
let relayToken: { token: string; expiresAt: number } | null = null
let relayRegistrationUnavailable = false

const HealthSchema = z.object({
  service: z.literal("mako-backend"),
  version: z.string(),
  environment: z.enum(["development", "preview", "production"]),
  mcp: z.object({
    protocol: z.literal("streamable-http"),
    endpoint: z.string(),
    authenticated: z.literal(true),
  }),
})

export type BackendConnectionStatus =
  | { kind: "connected"; url: string; version: string; environment: string }
  | { kind: "missing-token"; url: string }
  | { kind: "unreachable"; url: string; detail: string }

async function keychainValue(
  service: string,
  account: string
): Promise<string | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function writeKeychainValue(
  service: string,
  account: string,
  value: string
): Promise<void> {
  if (process.platform !== "darwin") return
  await run("security", [
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-w",
    value,
  ])
}

export async function ensureBackendConnectionEnvironment(): Promise<void> {
  backendUrl = process.env.MAKO_BACKEND_URL ?? backendUrl
  backendToken ??=
    process.env.MAKO_BACKEND_TOKEN ??
    (await keychainValue(KEYCHAIN_SERVICE, userInfo().username)) ??
    undefined
}

export function backendConnectionCredentials(): {
  token: string
  url: string
} | null {
  const token = process.env.MAKO_BACKEND_TOKEN ?? backendToken
  const url = process.env.MAKO_BACKEND_URL ?? backendUrl
  return token ? { token, url } : null
}

export async function configureBackendRelayDevice(device: {
  deviceId: string
  deviceName: string
  defaultHarness: string
}): Promise<void> {
  relayDevice = device
  relayCredential = undefined
  relayToken = null
}

async function loadRelayCredential(): Promise<
  { tenantId: string; deviceSecret: string } | null
> {
  if (!relayDevice) return null
  if (relayCredential !== undefined) return relayCredential
  const stored = await keychainValue(
    RELAY_KEYCHAIN_SERVICE,
    relayDevice.deviceId
  )
  if (!stored) {
    relayCredential = null
    return null
  }
  try {
    relayCredential = z
      .object({
        tenantId: z.string().min(1).max(80),
        deviceSecret: z.string().min(64),
      })
      .parse(JSON.parse(stored))
  } catch {
    relayCredential = null
  }
  return relayCredential
}

async function registerRelayDevice(): Promise<
  { tenantId: string; deviceSecret: string } | null
> {
  if (!relayDevice || relayRegistrationUnavailable) return null
  const credentials = backendConnectionCredentials()
  if (!credentials) return null
  const response = await fetch(new URL("/api/relay/register", credentials.url), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(relayDevice),
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) {
    relayRegistrationUnavailable = true
    return null
  }
  if (!response.ok)
    throw new Error(`Relay device registration returned ${response.status}`)
  const registered = RelayRegistrationResponseSchema.parse(await response.json())
  const credential = {
    tenantId: registered.tenantId,
    deviceSecret: registered.deviceSecret,
  }
  await writeKeychainValue(
    RELAY_KEYCHAIN_SERVICE,
    relayDevice.deviceId,
    JSON.stringify(credential)
  )
  relayCredential = credential
  return credential
}

async function deviceRelayToken(): Promise<string | null> {
  if (!relayDevice || relayRegistrationUnavailable) return null
  const now = Math.floor(Date.now() / 1_000)
  if (relayToken && relayToken.expiresAt > now + 60) return relayToken.token
  const credential =
    (await loadRelayCredential()) ?? (await registerRelayDevice())
  if (!credential) return null
  const unsigned = {
    tenantId: credential.tenantId,
    deviceId: relayDevice.deviceId,
    nonce: randomUUID(),
    timestamp: Date.now(),
  }
  const response = await fetch(
    new URL("/api/relay/token", backendConnectionCredentials()?.url ?? backendUrl),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...unsigned,
        signature: signRelayTokenRequest(unsigned, credential.deviceSecret),
      }),
      signal: AbortSignal.timeout(15_000),
    }
  )
  if (response.status === 404) {
    relayRegistrationUnavailable = true
    return null
  }
  if (!response.ok) throw new Error(`Relay token returned ${response.status}`)
  relayToken = RelayTokenResponseSchema.parse(await response.json())
  return relayToken.token
}

async function relayAuthorization(): Promise<{
  token: string
  url: string
}> {
  await ensureBackendConnectionEnvironment()
  const credentials = backendConnectionCredentials()
  if (!credentials) throw new Error("Mako backend token is missing")
  return {
    token: (await deviceRelayToken()) ?? credentials.token,
    url: credentials.url,
  }
}

export async function backendRelayPost(
  path: string,
  body: string,
  signal?: AbortSignal
): Promise<Response> {
  const credentials = await relayAuthorization()
  return fetch(new URL(path, credentials.url), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    },
    body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  })
}

export async function backendRelayUpload(
  path: string,
  body: FormData
): Promise<Response> {
  const credentials = await relayAuthorization()
  return fetch(new URL(path, credentials.url), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.token}`,
    },
    body,
    signal: AbortSignal.timeout(60_000),
  })
}

export async function backendConnectionStatus(): Promise<BackendConnectionStatus> {
  await ensureBackendConnectionEnvironment()
  const credentials = backendConnectionCredentials()
  const url = credentials?.url ?? backendUrl
  if (!credentials) return { kind: "missing-token", url }
  try {
    const endpoint = new URL("/api/health", url)
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`Health check returned ${response.status}`)
    const health = HealthSchema.parse(await response.json())
    return {
      kind: "connected",
      url,
      version: health.version,
      environment: health.environment,
    }
  } catch (error) {
    return {
      kind: "unreachable",
      url,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
