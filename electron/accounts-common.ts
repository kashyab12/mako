import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { JsonValue } from "./codex-app-json.js"

const run = promisify(execFile)

/** Runtime-only values must never leak into a provider child process. */
const MAKO_RUNTIME_ENV = ["MAKO_BACKEND_TOKEN", "MAKO_CUA_SOCKET"]

export function accountsRoot(): string {
  return join(homedir(), ".mako", "accounts")
}

export function accountDir(provider: string, name: string): string {
  return join(accountsRoot(), provider, name)
}

function statePath(): string {
  return join(accountsRoot(), "state.json")
}

export function valueFields(
  value: JsonValue | undefined
): Map<string, JsonValue> | null {
  if (Object.prototype.toString.call(value) !== "[object Object]") return null
  return new Map(Object.entries(Object(value)))
}

export function jsonFields(contents: string): Map<string, JsonValue> {
  const value: JsonValue = JSON.parse(contents)
  return valueFields(value) ?? new Map()
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : undefined
}

export function numberValue(value: JsonValue | undefined): number | undefined {
  if (Object.prototype.toString.call(value) !== "[object Number]")
    return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseSelectionState(contents: string): Map<string, string | null> {
  const state = new Map<string, string | null>()
  for (const [provider, value] of jsonFields(contents)) {
    const name = stringValue(value)
    if (name !== undefined || value === null) state.set(provider, name ?? null)
  }
  return state
}

export async function readSelection(provider: string): Promise<string | null> {
  try {
    return (
      parseSelectionState(await readFile(statePath(), "utf8")).get(provider) ??
      null
    )
  } catch {
    return null
  }
}

export async function writeSelection(
  provider: string,
  name: string | null
): Promise<void> {
  let state = new Map<string, string | null>()
  try {
    state = parseSelectionState(await readFile(statePath(), "utf8"))
  } catch {
    // The first selection creates the state file.
  }
  state.set(provider, name)
  await mkdir(accountsRoot(), { recursive: true })
  await writeFile(
    statePath(),
    JSON.stringify(Object.fromEntries(state), null, 2),
    "utf8"
  )
}

export function childProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of MAKO_RUNTIME_ENV) delete env[key]
  return env
}

export function cleanAccountName(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
  if (!clean || clean === "default")
    throw new Error("Pick a different account name")
  return clean
}

/**
 * Point an account home's shared entries at the real home. Re-run at every
 * spawn, because a skills directory created *after* capture should appear
 * under every account the moment it exists.
 */
export async function ensureSharedLinks(
  realHome: string,
  dir: string,
  links: readonly string[]
): Promise<void> {
  for (const link of links) {
    const target = join(realHome, link)
    const at = join(dir, link)
    if (!existsSync(target) || existsSync(at)) continue
    await symlink(target, at).catch(() => {})
  }
}

export function parseUsageReset(value: JsonValue | undefined): number | null {
  const seconds = numberValue(value)
  if (seconds !== undefined) return seconds * (seconds < 1e12 ? 1000 : 1)
  const timestamp = stringValue(value)
  if (timestamp === undefined) return null
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

export interface JwtClaims {
  email?: string
  accountId?: string
}

export function jwtClaims(token: string | undefined): JwtClaims {
  if (!token) return {}
  const payload = token.split(".")[1]
  if (!payload) return {}
  try {
    const fields = jsonFields(
      Buffer.from(payload, "base64url").toString("utf8")
    )
    const nested = valueFields(fields.get("https://api.openai.com/auth"))
    const profile = valueFields(fields.get("https://api.openai.com/profile"))
    const organizations = fields.get("organizations")
    const firstOrganization = Array.isArray(organizations)
      ? valueFields(organizations[0])
      : null
    const email =
      stringValue(fields.get("email")) ?? stringValue(profile?.get("email"))
    const accountId =
      stringValue(fields.get("chatgpt_account_id")) ??
      stringValue(nested?.get("chatgpt_account_id")) ??
      stringValue(firstOrganization?.get("id"))
    const claims: JwtClaims = {}
    if (email !== undefined) claims.email = email
    if (accountId !== undefined) claims.accountId = accountId
    return claims
  } catch {
    return {}
  }
}

export async function readKeychain(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function writeKeychain(
  service: string,
  contents: string
): Promise<void> {
  if (process.platform !== "darwin") return
  const user = userInfo().username
  await run("security", [
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    user,
    "-w",
    contents,
  ]).catch(() => {})
}
