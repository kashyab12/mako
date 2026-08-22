import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  AccountUsage,
  ClassifiedUsageWindows,
  HarnessAccount,
  OpenCodeAuthType,
  UsageWindow,
} from "../../account-types.js"
import {
  jsonFields,
  jwtClaims,
  numberValue,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { ObservedAccountCapability } from "../account-capability.js"

interface OpenCodeCredential {
  type: OpenCodeAuthType
  access?: string
  accountId?: string
}

interface UsageResponse {
  plan?: string
  windows: UsageWindow[]
}

function authFile(): string {
  return join(homedir(), ".local", "share", "opencode", "auth.json")
}

function parseCredential(
  value: JsonValue | undefined
): OpenCodeCredential | null {
  const fields = valueFields(value)
  const type = stringValue(fields?.get("type"))
  if (type !== "oauth" && type !== "api" && type !== "wellknown") return null
  if (type !== "oauth") return { type }
  const access = stringValue(fields?.get("access"))
  const accountId = stringValue(fields?.get("accountId"))
  const credential: OpenCodeCredential = { type }
  if (access !== undefined) credential.access = access
  if (accountId !== undefined) credential.accountId = accountId
  return credential
}

function parseCredentials(contents: string): Map<string, OpenCodeCredential> {
  const credentials = new Map<string, OpenCodeCredential>()
  for (const [providerId, value] of jsonFields(contents)) {
    const credential = parseCredential(value)
    if (credential) credentials.set(providerId, credential)
  }
  return credentials
}

/** Public metadata only: no access, refresh, API key, or expiry escapes. */
export function parseOpenCodeAccounts(
  contents: string,
  path = authFile()
): HarnessAccount[] {
  return [...parseCredentials(contents)].map(([providerId, credential]) => {
    const claims = jwtClaims(credential.access)
    const accountId = claims.accountId ?? credential.accountId
    const account: HarnessAccount = {
      harness: "opencode",
      name: providerId,
      providerId,
      authType: credential.type,
      dir: path,
      active: true,
      source: "opencode",
    }
    if (claims.email !== undefined) account.email = claims.email
    if (accountId !== undefined) account.accountId = accountId
    return account
  })
}

function parseBackendWindow(value: JsonValue | undefined): UsageWindow | null {
  const fields = valueFields(value)
  if (!fields) return null
  const usedPercent = numberValue(fields.get("used_percent"))
  if (usedPercent === undefined) return null
  const windowSeconds = numberValue(fields.get("limit_window_seconds")) ?? 0
  const resetSeconds = numberValue(fields.get("reset_after_seconds"))
  return {
    usedPercent,
    windowMinutes: Math.round(windowSeconds / 60),
    resetsAt:
      resetSeconds === undefined ? null : Date.now() + resetSeconds * 1000,
  }
}

function parseUsageResponse(contents: string): UsageResponse {
  const fields = jsonFields(contents)
  const rateLimit = valueFields(fields.get("rate_limit"))
  const windows = [
    parseBackendWindow(rateLimit?.get("primary_window")),
    parseBackendWindow(rateLimit?.get("secondary_window")),
  ]
    .filter((entry): entry is UsageWindow => entry !== null)
    .sort((a, b) => a.windowMinutes - b.windowMinutes)
  const plan = stringValue(fields.get("plan_type"))
  return plan === undefined ? { windows } : { plan, windows }
}

function classifyWindows(windows: UsageWindow[]): ClassifiedUsageWindows {
  return {
    session: windows.find((window) => window.windowMinutes <= 24 * 60) ?? null,
    weekly:
      [...windows].reverse().find((window) => window.windowMinutes > 24 * 60) ??
      null,
  }
}

async function chatGptUsage(
  accessToken: string,
  accountId: string | undefined
): Promise<AccountUsage> {
  try {
    const headers = new Headers({ Authorization: `Bearer ${accessToken}` })
    if (accountId) headers.set("ChatGPT-Account-Id", accountId)
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401) {
      return {
        status: "stale-token",
        detail: "Refreshes the next time OpenCode runs",
      }
    }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    const usage = parseUsageResponse(await response.text())
    const windows = classifyWindows(usage.windows)
    return {
      status: "ok",
      plan: usage.plan,
      session: windows.session,
      weekly: windows.weekly,
    }
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function accountUsage(providerId: string): Promise<AccountUsage> {
  let credential: OpenCodeCredential | undefined
  try {
    credential = parseCredentials(await readFile(authFile(), "utf8")).get(
      providerId
    )
  } catch {
    return { status: "missing-credentials" }
  }
  if (!credential) return { status: "missing-credentials" }
  if (providerId !== "openai") {
    return {
      status: "unavailable",
      detail: `Native usage is unavailable for ${providerId}`,
    }
  }
  if (credential.type !== "oauth") {
    return {
      status: "unavailable",
      detail:
        credential.type === "api"
          ? "Usage is unavailable for API-key credentials"
          : "Usage is unavailable for well-known credentials",
    }
  }
  if (!credential.access) return { status: "missing-credentials" }
  return chatGptUsage(
    credential.access,
    credential.accountId ?? jwtClaims(credential.access).accountId
  )
}

export const openCodeAccountCapability: ObservedAccountCapability = {
  provider: "opencode",
  mode: "observed",
  listAccounts: async () => {
    const path = authFile()
    return readFile(path, "utf8")
      .then((contents) => parseOpenCodeAccounts(contents, path))
      .catch(() => [])
  },
  // OpenCode owns a multi-provider auth file and does not select isolated homes.
  accountEnv: async (_selection, base) => ({ ...base }),
  selectedAccount: () => ({ name: "default" }),
  accountUsage,
}
