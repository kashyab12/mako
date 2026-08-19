/**
 * Several accounts per harness, one machine.
 *
 * The mechanism is borrowed from Orca, which does this right: an account is
 * an *isolated config home* — a directory holding nothing but credentials —
 * selected by environment variable at spawn time (`CLAUDE_CONFIG_DIR` for
 * Claude Code, `CODEX_HOME` for Codex). No harness ever knows more than one
 * account exists; it just wakes up in a home that happens to hold different
 * keys.
 *
 * Two decisions keep this sane:
 *
 *   * **Everything except credentials is a symlink back to the real home.**
 *     Skills, agents, commands, prompts, config — and above all the session
 *     stores — are shared. Switch accounts and every skill is still there,
 *     every session is still in the rail, and new sessions land in the same
 *     watched store. The *only* thing an account isolates is who pays.
 *   * **Credentials are captured, never invented.** "Add account" copies the
 *     login the CLI already has — sign into the other account with the CLI
 *     as usual, capture it here, switch back. On macOS, Claude Code 2.1+
 *     scopes its Keychain entry by `sha256(configDir)[:8]`, so capture also
 *     writes the scoped Keychain entry the spawned CLI will actually read.
 *
 * Usage comes from the providers' own endpoints, the way Orca fetches it:
 * Claude's OAuth usage API (five-hour and seven-day windows) and Codex's
 * backend usage API (primary/secondary rate-limit windows). A stale token is
 * a classified state, not an error toast — Claude refreshes its own token
 * the next time it runs, and the number appears.
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { JsonValue } from "./codex-app-protocol.js"

const run = promisify(execFile)

export type AccountHarness = "claude" | "codex"

export interface HarnessAccount {
  harness: AccountHarness
  name: string
  /** The login's actual identity — the email a human recognizes. */
  email?: string
  /** The isolated config home this account materializes as. */
  dir: string
  active: boolean
  /** Where the login came from: captured here, or found in a router's config. */
  source?: "mako" | "subrouter"
}

export interface UsageWindow {
  usedPercent: number
  windowMinutes: number
  /** Unix ms when the window resets, when the provider says. */
  resetsAt: number | null
}

export interface AccountUsage {
  status: "ok" | "stale-token" | "missing-credentials" | "error"
  plan?: string
  session?: UsageWindow | null
  weekly?: UsageWindow | null
  detail?: string
}

/** Env vars that would override file credentials and cross accounts. */
const CLAUDE_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]
const CODEX_AUTH_ENV = ["OPENAI_API_KEY"]

/** What stays shared across accounts, per harness. Everything but the keys. */
const SHARED = {
  claude: {
    home: ".claude",
    links: [
      "projects",
      "skills",
      "agents",
      "commands",
      "plugins",
      "hooks",
      "CLAUDE.md",
      "settings.json",
      "todos",
    ],
    copies: [".credentials.json"],
  },
  codex: {
    home: ".codex",
    links: [
      "sessions",
      "skills",
      "prompts",
      "hooks",
      "config.toml",
      "AGENTS.md",
    ],
    copies: ["auth.json"],
  },
}

function accountsRoot(): string {
  return join(homedir(), ".mako", "accounts")
}

function statePath(): string {
  return join(accountsRoot(), "state.json")
}

interface SelectionState {
  claude?: string | null
  codex?: string | null
}

interface ClaudeConfig {
  email?: string
}

interface CodexAuth {
  idToken?: string
  accessToken?: string
  accountId?: string
}

interface JwtClaims {
  email?: string
}

interface RouterClaudeProfile {
  email: string
  dir: string
}

interface RouterClaudeConfig {
  profiles: RouterClaudeProfile[]
}

interface RouterCodexAccount {
  auth: CodexAuth
  authJson: string
}

interface ClaudeCredentials {
  accessToken?: string
}

interface ClaudeUsageResponse {
  session: UsageWindow | null
  weekly: UsageWindow | null
}

interface CodexUsageResponse {
  plan?: string
  windows: UsageWindow[]
}

function valueFields(
  value: JsonValue | undefined
): Map<string, JsonValue> | null {
  if (Object.prototype.toString.call(value) !== "[object Object]") return null
  return new Map(Object.entries(Object(value)))
}

function jsonFields(contents: string): Map<string, JsonValue> {
  const value: JsonValue = JSON.parse(contents)
  return valueFields(value) ?? new Map()
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  if (Object.prototype.toString.call(value) !== "[object Number]")
    return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseSelectionState(contents: string): SelectionState {
  const fields = jsonFields(contents)
  const state: SelectionState = {}
  const claude = fields.get("claude")
  const codex = fields.get("codex")
  const claudeName = stringValue(claude)
  const codexName = stringValue(codex)
  if (claudeName !== undefined || claude === null)
    state.claude = claudeName ?? null
  if (codexName !== undefined || codex === null) state.codex = codexName ?? null
  return state
}

function parseClaudeConfig(contents: string): ClaudeConfig {
  const account = valueFields(jsonFields(contents).get("oauthAccount"))
  const email = stringValue(account?.get("emailAddress"))
  return email === undefined ? {} : { email }
}

function parseCodexAuthValue(value: JsonValue | undefined): CodexAuth {
  const tokens = valueFields(valueFields(value)?.get("tokens"))
  if (!tokens) return {}
  const auth: CodexAuth = {}
  const idToken = stringValue(tokens.get("id_token"))
  const accessToken = stringValue(tokens.get("access_token"))
  const accountId = stringValue(tokens.get("account_id"))
  if (idToken !== undefined) auth.idToken = idToken
  if (accessToken !== undefined) auth.accessToken = accessToken
  if (accountId !== undefined) auth.accountId = accountId
  return auth
}

function parseCodexAuth(contents: string): CodexAuth {
  const value: JsonValue = JSON.parse(contents)
  return parseCodexAuthValue(value)
}

function parseJwtClaims(contents: string): JwtClaims {
  const email = stringValue(jsonFields(contents).get("email"))
  return email === undefined ? {} : { email }
}

function parseRouterClaudeConfig(contents: string): RouterClaudeConfig {
  const profiles = valueFields(jsonFields(contents).get("profiles"))
  if (!profiles) return { profiles: [] }
  const parsed: RouterClaudeProfile[] = []
  for (const [email, value] of profiles) {
    const dir = stringValue(valueFields(value)?.get("dir"))
    if (dir !== undefined) parsed.push({ email, dir })
  }
  return { profiles: parsed }
}

function parseRouterCodexAccount(contents: string): RouterCodexAccount {
  const fields = jsonFields(contents)
  const authValue = fields.get("auth")
  const authFields = valueFields(authValue)
  return {
    auth: parseCodexAuthValue(authValue),
    authJson: authFields
      ? JSON.stringify(Object.fromEntries(authFields))
      : "{}",
  }
}

function parseClaudeCredentials(contents: string): ClaudeCredentials {
  const oauth = valueFields(jsonFields(contents).get("claudeAiOauth"))
  const accessToken = stringValue(oauth?.get("accessToken"))
  return accessToken === undefined ? {} : { accessToken }
}

function parseUsageReset(value: JsonValue | undefined): number | null {
  const seconds = numberValue(value)
  if (seconds !== undefined) return seconds * (seconds < 1e12 ? 1000 : 1)
  const timestamp = stringValue(value)
  if (timestamp === undefined) return null
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

function parseClaudeUsageWindow(
  value: JsonValue | undefined,
  windowMinutes: number
): UsageWindow | null {
  const fields = valueFields(value)
  if (!fields) return null
  const used =
    numberValue(fields.get("utilization")) ??
    numberValue(fields.get("used_percentage"))
  if (used === undefined) return null
  return {
    usedPercent: used,
    windowMinutes,
    resetsAt: parseUsageReset(fields.get("resets_at")),
  }
}

function parseClaudeUsageResponse(contents: string): ClaudeUsageResponse {
  const fields = jsonFields(contents)
  return {
    session: parseClaudeUsageWindow(fields?.get("five_hour"), 300),
    weekly: parseClaudeUsageWindow(fields?.get("seven_day"), 10_080),
  }
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

function parseCodexUsageResponse(contents: string): CodexUsageResponse {
  const fields = jsonFields(contents)
  const rateLimit = valueFields(fields?.get("rate_limit"))
  const windows = [
    parseBackendWindow(rateLimit?.get("primary_window")),
    parseBackendWindow(rateLimit?.get("secondary_window")),
  ]
    .filter((entry): entry is UsageWindow => entry !== null)
    .sort((a, b) => a.windowMinutes - b.windowMinutes)
  const plan = stringValue(fields?.get("plan_type"))
  return plan === undefined ? { windows } : { plan, windows }
}

async function readSelection(): Promise<SelectionState> {
  try {
    return parseSelectionState(await readFile(statePath(), "utf8"))
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------ listing */

/**
 * Who a login actually is. "default" is a mechanism, not an identity — the
 * email in the account dir's own config is what a human recognizes.
 * Claude keeps it in .claude.json's oauthAccount; Codex inside the id_token
 * JWT in auth.json. Absent or unreadable simply yields nothing.
 */
async function accountEmail(
  harness: AccountHarness,
  dir: string
): Promise<string | undefined> {
  try {
    if (harness === "claude") {
      const config = parseClaudeConfig(
        await readFile(join(dir, ".claude.json"), "utf8")
      )
      return config.email
    }
    const auth = parseCodexAuth(await readFile(join(dir, "auth.json"), "utf8"))
    if (!auth.idToken) return undefined
    const payload = auth.idToken.split(".")[1]
    if (!payload) return undefined
    const claims = parseJwtClaims(
      Buffer.from(payload, "base64url").toString("utf8")
    )
    return claims.email
  } catch {
    return undefined
  }
}

/** Where a claude account dir keeps its state file vs codex's flat home. */
function identityDir(harness: "claude" | "codex", dir: string): string {
  // The default claude "dir" is ~/.claude but .claude.json sits beside it in
  // the home; captured accounts keep the same shape inside their own root.
  return harness === "claude" ? join(dir, "..") : dir
}

/**
 * Accounts a router already manages. Subrouter keeps Claude profiles in
 * <router>/claude.json (each with its own config dir — directly usable as
 * CLAUDE_CONFIG_DIR) and Codex logins as <router>/accounts/<email>.json
 * (tokens only — selecting one materializes a home). People with a router
 * installed already did the multi-account work; Mako meets them there.
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
      const config = parseRouterClaudeConfig(
        await readFile(join(root, router, "claude.json"), "utf8")
      )
      for (const profile of config.profiles) {
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
      // This router has no claude profiles.
    }
    try {
      for (const file of await readdir(join(root, router, "accounts"))) {
        if (!file.endsWith(".json")) continue
        const email = file.slice(0, -".json".length)
        accounts.push({
          harness: "codex",
          name: email,
          email,
          dir: join(root, router, "accounts", file),
          active: false,
          source: "subrouter",
        })
      }
    } catch {
      // This router has no codex accounts.
    }
  }
  return accounts
}

export async function listAccounts(): Promise<HarnessAccount[]> {
  const selection = await readSelection()
  const accounts: HarnessAccount[] = []
  for (const harness of ["claude", "codex"] as const) {
    // The real home is always an account: the one the CLI manages itself.
    const defaultDir = join(homedir(), SHARED[harness].home)
    accounts.push({
      harness,
      name: "default",
      email: await accountEmail(harness, identityDir(harness, defaultDir)),
      dir: defaultDir,
      active: !selection[harness],
    })
    try {
      for (const name of await readdir(join(accountsRoot(), harness))) {
        if (name.startsWith(".")) continue
        const dir = join(accountsRoot(), harness, name)
        accounts.push({
          harness,
          name,
          email: await accountEmail(harness, identityDir(harness, dir)),
          dir,
          active: selection[harness] === name,
        })
      }
    } catch {
      // No captured accounts for this harness yet.
    }
  }
  // Router-managed logins ride along, deduped by identity against what
  // Mako captured itself.
  const known = new Set(
    accounts.map(
      (account) => `${account.harness}:${account.email ?? account.name}`
    )
  )
  for (const account of await subrouterAccounts()) {
    if (known.has(`${account.harness}:${account.email ?? account.name}`))
      continue
    accounts.push(account)
  }
  return accounts
}

/* ------------------------------------------------------------ capture */

/**
 * Capture the harness's *current* login as a named account.
 *
 * Sign into the other account with the CLI the ordinary way, capture, and
 * switch back — the same flow Orca lands on, because login is a browser
 * OAuth dance only the CLI itself can drive.
 */
export async function captureAccount(
  harness: AccountHarness,
  name: string
): Promise<void> {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
  if (!clean || clean === "default")
    throw new Error("Pick a different account name")
  const spec = SHARED[harness]
  const realHome = join(homedir(), spec.home)
  const dir = join(accountsRoot(), harness, clean)
  await mkdir(dir, { recursive: true })

  // Credentials: copied, and required — an account with no keys is nothing.
  let captured = false
  for (const file of spec.copies) {
    const source = join(realHome, file)
    if (!existsSync(source)) continue
    await copyFile(source, join(dir, file))
    await chmod(join(dir, file), 0o600)
    captured = true
  }

  if (harness === "claude") {
    // On macOS the live credentials usually live in the Keychain, not the
    // file — and Claude Code 2.1+ reads a Keychain entry *scoped to the
    // config dir* it wakes up in. Capture to both places the spawned CLI
    // might look.
    const keychainJson = await readKeychain("Claude Code-credentials")
    if (keychainJson) {
      await writeFile(join(dir, ".credentials.json"), keychainJson, {
        mode: 0o600,
      })
      await writeKeychain(scopedClaudeService(dir), keychainJson)
      captured = true
    }
    // The CLI's onboarding/config state, so a captured account does not
    // re-run first-time setup. Copied, not linked: it embeds account state.
    const config = join(homedir(), ".claude.json")
    if (existsSync(config)) await copyFile(config, join(dir, ".claude.json"))
  }

  if (!captured) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(
      `No ${harness} login found to capture — sign in with the CLI first`
    )
  }

  // Everything else is the same home, by reference. Sessions land in the
  // one watched store; a skill added under any account exists under all.
  await ensureLinks(harness, dir)
}

/**
 * Point the account home's shared entries at the real home. Re-run at every
 * spawn, because a skills directory created *after* capture should appear
 * under every account the moment it exists — nine existsSync calls is the
 * whole cost.
 */
async function ensureLinks(
  harness: AccountHarness,
  dir: string
): Promise<void> {
  const spec = SHARED[harness]
  const realHome = join(homedir(), spec.home)
  for (const link of spec.links) {
    const target = join(realHome, link)
    const at = join(dir, link)
    if (!existsSync(target) || existsSync(at)) continue
    await symlink(target, at).catch(() => {})
  }
}

export async function removeAccount(
  harness: AccountHarness,
  name: string
): Promise<void> {
  if (name === "default")
    throw new Error("The default account is the CLI's own login")
  const selection = await readSelection()
  if (selection[harness] === name) await selectAccount(harness, null)
  await rm(join(accountsRoot(), harness, name), {
    recursive: true,
    force: true,
  })
}

/* ------------------------------------------------------------ selection */

/** `null` selects the CLI's own login (the real home, untouched). */
export async function selectAccount(
  harness: AccountHarness,
  name: string | null
): Promise<void> {
  const selection = await readSelection()
  selection[harness] = name
  await mkdir(accountsRoot(), { recursive: true })
  await writeFile(statePath(), JSON.stringify(selection, null, 2), "utf8")
}

/**
 * The environment for spawning a harness CLI under the selected account.
 *
 * Applied by every spawn path — headless drivers, fresh continuations, ACP —
 * so "switch account" means every future run, not some of them. Auth env
 * vars are stripped either way: an inherited `ANTHROPIC_API_KEY` silently
 * overriding the chosen account is the bug this whole file exists to avoid.
 */
export async function accountEnv(
  harness: string,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const env = { ...base }
  if (harness === "claude" || harness === "codex") {
    for (const key of harness === "claude" ? CLAUDE_AUTH_ENV : CODEX_AUTH_ENV)
      delete env[key]
    const selection = await readSelection()
    const name = selection[harness]
    if (name) {
      let dir = join(accountsRoot(), harness, name)
      if (!existsSync(dir)) {
        // A router-managed login. Claude profiles are real config homes and
        // route directly; a Codex account file materializes into a Mako
        // home once (auth copied, sessions/skills symlinked) and routes
        // like any captured account from then on.
        const routed = (await subrouterAccounts()).find(
          (account) => account.harness === harness && account.name === name
        )
        if (routed && harness === "claude") {
          dir = routed.dir
        } else if (routed && harness === "codex") {
          dir = join(accountsRoot(), "codex", name)
          if (!existsSync(join(dir, "auth.json"))) {
            try {
              const account = parseRouterCodexAccount(
                await readFile(routed.dir, "utf8")
              )
              await mkdir(dir, { recursive: true })
              await writeFile(join(dir, "auth.json"), account.authJson, "utf8")
              await chmod(join(dir, "auth.json"), 0o600)
            } catch {
              // Unreadable router file: fall through to the default home.
            }
          }
        }
      }
      if (existsSync(dir)) {
        await ensureLinks(harness, dir)
        if (harness === "claude") env.CLAUDE_CONFIG_DIR = dir
        else env.CODEX_HOME = dir
      }
    }
  }
  return env
}

/* ------------------------------------------------------------ usage */

const usageCache = new Map<string, { at: number; usage: AccountUsage }>()
const USAGE_CACHE_MS = 60_000

export async function accountUsage(
  harness: AccountHarness,
  name: string
): Promise<AccountUsage> {
  const key = `${harness}:${name}`
  const cached = usageCache.get(key)
  if (cached && Date.now() - cached.at < USAGE_CACHE_MS) return cached.usage
  // Router-managed accounts resolve by identity, not by a Mako-owned dir.
  const routed = (await subrouterAccounts()).find(
    (account) => account.harness === harness && account.name === name
  )
  const dir =
    routed?.dir ??
    (name === "default"
      ? join(homedir(), SHARED[harness].home)
      : join(accountsRoot(), harness, name))
  const usage =
    harness === "claude"
      ? await claudeUsage(dir, name === "default")
      : await codexUsage(dir)
  usageCache.set(key, { at: Date.now(), usage })
  return usage
}

async function claudeUsage(
  dir: string,
  isDefault: boolean
): Promise<AccountUsage> {
  let raw: string | null
  try {
    raw = await readFile(join(dir, ".credentials.json"), "utf8")
  } catch {
    // The default account on macOS keeps credentials in the Keychain.
    raw = isDefault
      ? await readKeychain("Claude Code-credentials")
      : await readKeychain(scopedClaudeService(dir))
  }
  let token: string | null = null
  try {
    token = raw ? (parseClaudeCredentials(raw).accessToken ?? null) : null
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
      // The token rotates when Claude itself runs; this is a wait, not a
      // failure.
      return {
        status: "stale-token",
        detail: "Refreshes the next time Claude Code runs",
      }
    }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    const usage = parseClaudeUsageResponse(await response.text())
    return {
      status: "ok",
      session: usage.session,
      weekly: usage.weekly,
    }
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function codexUsage(dir: string): Promise<AccountUsage> {
  let auth: CodexAuth
  try {
    if (dir.endsWith(".json")) {
      // A router's account file: {email, auth: {tokens}} — same tokens,
      // different wrapper.
      auth = parseRouterCodexAccount(await readFile(dir, "utf8")).auth
    } else {
      auth = parseCodexAuth(await readFile(join(dir, "auth.json"), "utf8"))
    }
  } catch {
    return { status: "missing-credentials" }
  }
  if (!auth.accessToken) return { status: "missing-credentials" }
  try {
    const headers = new Headers({ Authorization: `Bearer ${auth.accessToken}` })
    if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401) {
      return {
        status: "stale-token",
        detail: "Refreshes the next time Codex runs",
      }
    }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    const payload = await response.text()
    // Codex names its windows by position, not duration; sort by length so
    // "session" is always the shorter one whatever the backend calls it.
    const usage = parseCodexUsageResponse(payload)
    return {
      status: "ok",
      plan: usage.plan,
      session: usage.windows[0] ?? null,
      weekly: usage.windows[1] ?? usage.windows[0] ?? null,
    }
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/* ------------------------------------------------------------ keychain */

/** Claude Code 2.1+ scopes its Keychain entry by the config dir it runs in. */
function scopedClaudeService(configDir: string): string {
  const suffix = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

async function readKeychain(service: string): Promise<string | null> {
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

async function writeKeychain(service: string, contents: string): Promise<void> {
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

/* ------------------------------------------------------------ suggestion */

/**
 * The account with the most headroom in its five-hour window.
 *
 * Groundwork for automatic routing; today it powers the suggestion below.
 * Only accounts whose usage endpoint answered are candidates — an account
 * with a stale token might be empty or might be exhausted, and guessing is
 * worse than not suggesting.
 */
export async function pickAccount(
  harness: AccountHarness
): Promise<{ name: string; usedPercent: number } | null> {
  const accounts = (await listAccounts()).filter(
    (account) => account.harness === harness
  )
  let best: { name: string; usedPercent: number } | null = null
  for (const account of accounts) {
    const usage = await accountUsage(harness, account.name)
    if (usage.status !== "ok") continue
    const used = usage.session?.usedPercent ?? usage.weekly?.usedPercent ?? 0
    if (!best || used < best.usedPercent)
      best = { name: account.name, usedPercent: used }
  }
  return best
}

const suggestedAt = new Map<string, number>()
const SUGGEST_THROTTLE_MS = 60 * 60 * 1000

/**
 * Whether the user should hear about switching, and the words to say it in.
 *
 * Fires when the *active* account's session window is nearly spent and some
 * other account has real headroom. Never switches by itself: an account is
 * money, and money moves are the user's to make. Throttled to once an hour
 * per harness — a nag repeated is a nag ignored.
 */
export async function switchSuggestion(
  harness: AccountHarness
): Promise<string | null> {
  const last = suggestedAt.get(harness) ?? 0
  if (Date.now() - last < SUGGEST_THROTTLE_MS) return null
  const accounts = (await listAccounts()).filter(
    (account) => account.harness === harness
  )
  const active = accounts.find((account) => account.active)
  if (!active) return null
  const activeUsage = await accountUsage(harness, active.name)
  if (activeUsage.status !== "ok") return null
  const used =
    activeUsage.session?.usedPercent ?? activeUsage.weekly?.usedPercent ?? 0
  if (used < 90) return null
  const best = await pickAccount(harness)
  if (!best || best.name === active.name || best.usedPercent >= 70) return null
  suggestedAt.set(harness, Date.now())
  const label = harness === "claude" ? "Claude Code" : "Codex"
  return `${label} account "${active.name}" is at ${Math.round(used)}% of its window — "${best.name}" is at ${Math.round(best.usedPercent)}%. Switch in Settings → Agents.`
}
