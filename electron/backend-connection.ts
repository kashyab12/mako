import { execFile } from "node:child_process"
import { userInfo } from "node:os"
import { promisify } from "node:util"
import { z } from "zod"

const run = promisify(execFile)
const KEYCHAIN_SERVICE = "dev.mako.backend.mcp"
const DEFAULT_URL = "https://mako-pearl.vercel.app/api/mcp"
let backendUrl = process.env.MAKO_BACKEND_URL ?? DEFAULT_URL
let backendToken = process.env.MAKO_BACKEND_TOKEN

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

async function keychainToken(): Promise<string | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      userInfo().username,
      "-w",
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function ensureBackendConnectionEnvironment(): Promise<void> {
  backendUrl = process.env.MAKO_BACKEND_URL ?? backendUrl
  backendToken ??= process.env.MAKO_BACKEND_TOKEN ?? (await keychainToken()) ?? undefined
}

export function backendConnectionCredentials(): {
  token: string
  url: string
} | null {
  const token = process.env.MAKO_BACKEND_TOKEN ?? backendToken
  const url = process.env.MAKO_BACKEND_URL ?? backendUrl
  return token ? { token, url } : null
}

export async function backendRelayPost(
  path: string,
  body: string,
  signal?: AbortSignal
): Promise<Response> {
  await ensureBackendConnectionEnvironment()
  const credentials = backendConnectionCredentials()
  if (!credentials) throw new Error("Mako backend token is missing")
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
  await ensureBackendConnectionEnvironment()
  const credentials = backendConnectionCredentials()
  if (!credentials) throw new Error("Mako backend token is missing")
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
