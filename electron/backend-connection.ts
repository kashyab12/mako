import { execFile } from "node:child_process"
import { userInfo } from "node:os"
import { promisify } from "node:util"
import { z } from "zod"

const run = promisify(execFile)
const KEYCHAIN_SERVICE = "dev.mako.backend.mcp"
const DEFAULT_URL = "https://mako-pearl.vercel.app/api/mcp"

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
  process.env.MAKO_BACKEND_URL ??= DEFAULT_URL
  if (!process.env.MAKO_BACKEND_TOKEN) {
    const token = await keychainToken()
    if (token) process.env.MAKO_BACKEND_TOKEN = token
  }
}

export async function backendConnectionStatus(): Promise<BackendConnectionStatus> {
  await ensureBackendConnectionEnvironment()
  const url = process.env.MAKO_BACKEND_URL ?? DEFAULT_URL
  if (!process.env.MAKO_BACKEND_TOKEN) return { kind: "missing-token", url }
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
