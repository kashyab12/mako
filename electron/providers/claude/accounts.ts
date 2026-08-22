import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  AccountUsage,
  HarnessAccount,
  UsageWindow,
} from "../../account-types.js"
import {
  accountDir,
  accountsRoot,
  cleanAccountName,
  ensureSharedLinks,
  jsonFields,
  numberValue,
  parseUsageReset,
  readKeychain,
  stringValue,
  valueFields,
  writeKeychain,
} from "../../accounts-common.js"
import type { SelectableAccountCapability } from "../account-capability.js"

/** Env vars that would override file credentials and cross accounts. */
const AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]

/** Everything except credentials stays shared across accounts. */
const HOME = ".claude"
const SHARED_LINKS = [
  "projects",
  "skills",
  "agents",
  "commands",
  "plugins",
  "hooks",
  "CLAUDE.md",
  "settings.json",
  "todos",
]

interface RouterProfile {
  email: string
  dir: string
}

interface ClaudeUsageResponse {
  session: UsageWindow | null
  weekly: UsageWindow | null
}

function parseClaudeConfig(contents: string): string | undefined {
  const account = valueFields(jsonFields(contents).get("oauthAccount"))
  return stringValue(account?.get("emailAddress"))
}

function parseRouterProfiles(contents: string): RouterProfile[] {
  const profiles = valueFields(jsonFields(contents).get("profiles"))
  if (!profiles) return []
  const parsed: RouterProfile[] = []
  for (const [email, value] of profiles) {
    const dir = stringValue(valueFields(value)?.get("dir"))
    if (dir !== undefined) parsed.push({ email, dir })
  }
  return parsed
}

function parseAccessToken(contents: string): string | undefined {
  const oauth = valueFields(jsonFields(contents).get("claudeAiOauth"))
  return stringValue(oauth?.get("accessToken"))
}

function parseUsageWindow(
  value: Parameters<typeof valueFields>[0],
  windowMinutes: number
): UsageWindow | null {
  const fields = valueFields(value)
  if (!fields) return null
  const used =
    numberValue(fields.get("utilization")) ??
    numberValue(fields.get("used_percentage"))
  if (used === undefined || !Number.isFinite(used)) return null
  return {
    usedPercent: used,
    windowMinutes,
    resetsAt: parseUsageReset(fields.get("resets_at")),
  }
}

function parseUsageResponse(contents: string): ClaudeUsageResponse {
  const fields = jsonFields(contents)
  return {
    session: parseUsageWindow(fields.get("five_hour"), 300),
    weekly: parseUsageWindow(fields.get("seven_day"), 10_080),
  }
}

/** Where a Claude account dir keeps its state file. */
function identityDir(dir: string): string {
  // The default "dir" is ~/.claude but .claude.json sits beside it in the
  // home; captured accounts keep the same shape inside their own root.
  return join(dir, "..")
}

async function accountEmail(dir: string): Promise<string | undefined> {
  try {
    return parseClaudeConfig(await readFile(join(dir, ".claude.json"), "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Accounts a router already manages. Subrouter keeps Claude profiles in
 * <router>/claude.json, each with its own directly usable config dir.
 */
async function subrouterAccounts(): Promise<HarnessAccount[]> {
  const accounts: HarnessAccount[] = []
  const root = join(homedir(), ".subrouter")
  let routers: string[]
  try {
    routers = (await readdir(root)).filter(
      (name) => !name.startsWith(".") && !name.includes(".")
    )
  } catch {
    return accounts
  }
  for (const router of routers) {
    try {
      const profiles = parseRouterProfiles(
        await readFile(join(root, router, "claude.json"), "utf8")
      )
      for (const profile of profiles) {
        accounts.push({
          harness: "claude",
          name: profile.email,
          email: profile.email,
          dir: join(root, router, "claude", profile.dir),
          active: false,
          source: "subrouter",
        })
      }
    } catch {
      // This router has no Claude profiles.
    }
  }
  return accounts
}

async function listAccounts(
  selection: string | null
): Promise<HarnessAccount[]> {
  const accounts: HarnessAccount[] = []
  const defaultDir = join(homedir(), HOME)
  accounts.push({
    harness: "claude",
    name: "default",
    email: await accountEmail(identityDir(defaultDir)),
    dir: defaultDir,
    active: !selection,
  })
  try {
    for (const name of await readdir(join(accountsRoot(), "claude"))) {
      if (name.startsWith(".")) continue
      const dir = accountDir("claude", name)
      accounts.push({
        harness: "claude",
        name,
        email: await accountEmail(identityDir(dir)),
        dir,
        active: selection === name,
      })
    }
  } catch {
    // No captured Claude accounts yet.
  }

  // Router-managed logins ride along, deduped by identity against what Mako
  // captured itself.
  const known = new Set(
    accounts.map((account) => account.email ?? account.name)
  )
  for (const account of await subrouterAccounts()) {
    if (!known.has(account.email ?? account.name)) accounts.push(account)
  }
  return accounts
}

/** Claude Code 2.1+ scopes its Keychain entry by the config dir it runs in. */
function scopedService(configDir: string): string {
  const suffix = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

/**
 * Capture the CLI's current login as a named account. Credentials are copied,
 * never invented; browser OAuth remains the CLI's job.
 */
async function captureAccount(name: string): Promise<void> {
  const clean = cleanAccountName(name)
  const realHome = join(homedir(), HOME)
  const dir = accountDir("claude", clean)
  await mkdir(dir, { recursive: true })

  // Credentials are required — an account with no keys is nothing.
  let captured = false
  const source = join(realHome, ".credentials.json")
  if (existsSync(source)) {
    await copyFile(source, join(dir, ".credentials.json"))
    await chmod(join(dir, ".credentials.json"), 0o600)
    captured = true
  }

  // On macOS live credentials usually live in Keychain. Claude Code 2.1+
  // reads an entry scoped to the config dir it wakes up in, so capture both.
  const keychainJson = await readKeychain("Claude Code-credentials")
  if (keychainJson) {
    await writeFile(join(dir, ".credentials.json"), keychainJson, {
      mode: 0o600,
    })
    await writeKeychain(scopedService(dir), keychainJson)
    captured = true
  }

  // The CLI's onboarding/config state is copied, not linked: it embeds
  // account state and prevents first-time setup from running again.
  const config = join(homedir(), ".claude.json")
  if (existsSync(config)) await copyFile(config, join(dir, ".claude.json"))

  if (!captured) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(
      "No claude login found to capture — sign in with the CLI first"
    )
  }

  // Sessions and skills remain in the one watched store for every account.
  await ensureSharedLinks(realHome, dir, SHARED_LINKS)
}

async function removeAccount(name: string): Promise<void> {
  if (name === "default")
    throw new Error("The default account is the CLI's own login")
  await rm(accountDir("claude", name), { recursive: true, force: true })
}

async function accountEnv(
  selection: string | null,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const env = { ...base }
  for (const key of AUTH_ENV) delete env[key]
  if (!selection) return env

  let dir = accountDir("claude", selection)
  if (!existsSync(dir)) {
    // Router profiles are real config homes and route directly.
    const routed = (await subrouterAccounts()).find(
      (account) => account.name === selection
    )
    if (routed) dir = routed.dir
  }
  if (existsSync(dir)) {
    await ensureSharedLinks(join(homedir(), HOME), dir, SHARED_LINKS)
    env.CLAUDE_CONFIG_DIR = dir
  }
  return env
}

async function usageForDir(
  dir: string,
  isDefault: boolean
): Promise<AccountUsage> {
  let raw: string | null
  try {
    raw = await readFile(join(dir, ".credentials.json"), "utf8")
  } catch {
    // The default account on macOS keeps credentials in Keychain.
    raw = isDefault
      ? await readKeychain("Claude Code-credentials")
      : await readKeychain(scopedService(dir))
  }
  let token: string | null = null
  try {
    token = raw ? (parseAccessToken(raw) ?? null) : null
  } catch {
    // A corrupt credentials file reads as no credentials, not a crash.
  }
  if (!token) return { status: "missing-credentials" }
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401) {
      // Claude rotates the token itself; this is a wait, not a failure.
      return {
        status: "stale-token",
        detail: "Refreshes the next time Claude Code runs",
      }
    }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    const usage = parseUsageResponse(await response.text())
    return { status: "ok", session: usage.session, weekly: usage.weekly }
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function accountUsage(name: string): Promise<AccountUsage> {
  // Router-managed accounts resolve by identity, not by a Mako-owned dir.
  const routed = (await subrouterAccounts()).find(
    (account) => account.name === name
  )
  const dir =
    routed?.dir ??
    (name === "default" ? join(homedir(), HOME) : accountDir("claude", name))
  return usageForDir(dir, name === "default")
}

export const claudeAccountCapability: SelectableAccountCapability = {
  provider: "claude",
  mode: "selectable",
  suggestionLabel: "Claude Code",
  listAccounts,
  captureAccount,
  removeAccount,
  accountEnv,
  selectedAccount: (selection, env) =>
    selection && env.CLAUDE_CONFIG_DIR
      ? { name: selection, dir: env.CLAUDE_CONFIG_DIR }
      : { name: "default" },
  accountUsage,
}
