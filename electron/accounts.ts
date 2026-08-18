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
import { chmod, copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

export type AccountHarness = "claude" | "codex"

export interface HarnessAccount {
  harness: AccountHarness
  name: string
  /** The isolated config home this account materializes as. */
  dir: string
  active: boolean
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
const CLAUDE_AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
const CODEX_AUTH_ENV = ["OPENAI_API_KEY"]

/** What stays shared across accounts, per harness. Everything but the keys. */
const SHARED: Record<AccountHarness, { home: string; links: string[]; copies: string[] }> = {
  claude: {
    home: ".claude",
    links: ["projects", "skills", "agents", "commands", "plugins", "hooks", "CLAUDE.md", "settings.json", "todos"],
    copies: [".credentials.json"],
  },
  codex: {
    home: ".codex",
    links: ["sessions", "skills", "prompts", "hooks", "config.toml", "AGENTS.md"],
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

async function readSelection(): Promise<SelectionState> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as SelectionState
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------ listing */

export async function listAccounts(): Promise<HarnessAccount[]> {
  const selection = await readSelection()
  const accounts: HarnessAccount[] = []
  for (const harness of ["claude", "codex"] as const) {
    // The real home is always an account: the one the CLI manages itself.
    accounts.push({
      harness,
      name: "default",
      dir: join(homedir(), SHARED[harness].home),
      active: !selection[harness],
    })
    try {
      for (const name of await readdir(join(accountsRoot(), harness))) {
        if (name.startsWith(".")) continue
        accounts.push({
          harness,
          name,
          dir: join(accountsRoot(), harness, name),
          active: selection[harness] === name,
        })
      }
    } catch {
      // No captured accounts for this harness yet.
    }
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
export async function captureAccount(harness: AccountHarness, name: string): Promise<void> {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-")
  if (!clean || clean === "default") throw new Error("Pick a different account name")
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
      await writeFile(join(dir, ".credentials.json"), keychainJson, { mode: 0o600 })
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
    throw new Error(`No ${harness} login found to capture — sign in with the CLI first`)
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
async function ensureLinks(harness: AccountHarness, dir: string): Promise<void> {
  const spec = SHARED[harness]
  const realHome = join(homedir(), spec.home)
  for (const link of spec.links) {
    const target = join(realHome, link)
    const at = join(dir, link)
    if (!existsSync(target) || existsSync(at)) continue
    await symlink(target, at).catch(() => {})
  }
}

export async function removeAccount(harness: AccountHarness, name: string): Promise<void> {
  if (name === "default") throw new Error("The default account is the CLI's own login")
  const selection = await readSelection()
  if (selection[harness] === name) await selectAccount(harness, null)
  await rm(join(accountsRoot(), harness, name), { recursive: true, force: true })
}

/* ------------------------------------------------------------ selection */

/** `null` selects the CLI's own login (the real home, untouched). */
export async function selectAccount(harness: AccountHarness, name: string | null): Promise<void> {
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
export async function accountEnv(harness: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...base }
  if (harness === "claude" || harness === "codex") {
    for (const key of harness === "claude" ? CLAUDE_AUTH_ENV : CODEX_AUTH_ENV) delete env[key]
    const selection = await readSelection()
    const name = selection[harness]
    if (name) {
      const dir = join(accountsRoot(), harness, name)
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

export async function accountUsage(harness: AccountHarness, name: string): Promise<AccountUsage> {
  const key = `${harness}:${name}`
  const cached = usageCache.get(key)
  if (cached && Date.now() - cached.at < USAGE_CACHE_MS) return cached.usage
  const dir =
    name === "default" ? join(homedir(), SHARED[harness].home) : join(accountsRoot(), harness, name)
  const usage =
    harness === "claude" ? await claudeUsage(dir, name === "default") : await codexUsage(dir)
  usageCache.set(key, { at: Date.now(), usage })
  return usage
}

async function claudeUsage(dir: string, isDefault: boolean): Promise<AccountUsage> {
  let raw: string | null = null
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
    token = raw
      ? ((JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } })?.claudeAiOauth
          ?.accessToken ?? null)
      : null
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
      return { status: "stale-token", detail: "Refreshes the next time Claude Code runs" }
    }
    if (!response.ok) return { status: "error", detail: `HTTP ${response.status}` }
    const body = (await response.json()) as {
      five_hour?: { utilization?: number; used_percentage?: number; resets_at?: string | number }
      seven_day?: { utilization?: number; used_percentage?: number; resets_at?: string | number }
    }
    return {
      status: "ok",
      session: window(body.five_hour, 300),
      weekly: window(body.seven_day, 10_080),
    }
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) }
  }
}

async function codexUsage(dir: string): Promise<AccountUsage> {
  let auth: { tokens?: { access_token?: string; account_id?: string } }
  try {
    auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as typeof auth
  } catch {
    return { status: "missing-credentials" }
  }
  const token = auth.tokens?.access_token
  if (!token) return { status: "missing-credentials" }
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401) {
      return { status: "stale-token", detail: "Refreshes the next time Codex runs" }
    }
    if (!response.ok) return { status: "error", detail: `HTTP ${response.status}` }
    const body = (await response.json()) as {
      plan_type?: string
      rate_limit?: {
        primary_window?: BackendWindow
        secondary_window?: BackendWindow
      }
    }
    // Codex names its windows by position, not duration; sort by length so
    // "session" is always the shorter one whatever the backend calls it.
    const windows = [body.rate_limit?.primary_window, body.rate_limit?.secondary_window]
      .map(backendWindow)
      .filter((entry): entry is UsageWindow => entry !== null)
      .sort((a, b) => a.windowMinutes - b.windowMinutes)
    return {
      status: "ok",
      plan: body.plan_type,
      session: windows[0] ?? null,
      weekly: windows[1] ?? windows[0] ?? null,
    }
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) }
  }
}

interface BackendWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
}

function backendWindow(raw: BackendWindow | undefined): UsageWindow | null {
  if (!raw || typeof raw.used_percent !== "number") return null
  return {
    usedPercent: raw.used_percent,
    windowMinutes: Math.round((raw.limit_window_seconds ?? 0) / 60),
    resetsAt:
      typeof raw.reset_after_seconds === "number"
        ? Date.now() + raw.reset_after_seconds * 1000
        : null,
  }
}

function window(
  raw: { utilization?: number; used_percentage?: number; resets_at?: string | number } | undefined,
  windowMinutes: number
): UsageWindow | null {
  if (!raw) return null
  const used = raw.utilization ?? raw.used_percentage
  if (typeof used !== "number") return null
  let resetsAt: number | null = null
  if (typeof raw.resets_at === "number") resetsAt = raw.resets_at * (raw.resets_at < 1e12 ? 1000 : 1)
  else if (typeof raw.resets_at === "string") {
    const parsed = Date.parse(raw.resets_at)
    if (!Number.isNaN(parsed)) resetsAt = parsed
  }
  return { usedPercent: used, windowMinutes, resetsAt }
}

/* ------------------------------------------------------------ keychain */

/** Claude Code 2.1+ scopes its Keychain entry by the config dir it runs in. */
function scopedClaudeService(configDir: string): string {
  const suffix = createHash("sha256").update(configDir).digest("hex").slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

async function readKeychain(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, "-w"])
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
  const accounts = (await listAccounts()).filter((account) => account.harness === harness)
  let best: { name: string; usedPercent: number } | null = null
  for (const account of accounts) {
    const usage = await accountUsage(harness, account.name)
    if (usage.status !== "ok") continue
    const used = usage.session?.usedPercent ?? usage.weekly?.usedPercent ?? 0
    if (!best || used < best.usedPercent) best = { name: account.name, usedPercent: used }
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
export async function switchSuggestion(harness: AccountHarness): Promise<string | null> {
  const last = suggestedAt.get(harness) ?? 0
  if (Date.now() - last < SUGGEST_THROTTLE_MS) return null
  const accounts = (await listAccounts()).filter((account) => account.harness === harness)
  const active = accounts.find((account) => account.active)
  if (!active) return null
  const activeUsage = await accountUsage(harness, active.name)
  if (activeUsage.status !== "ok") return null
  const used = activeUsage.session?.usedPercent ?? activeUsage.weekly?.usedPercent ?? 0
  if (used < 90) return null
  const best = await pickAccount(harness)
  if (!best || best.name === active.name || best.usedPercent >= 70) return null
  suggestedAt.set(harness, Date.now())
  const label = harness === "claude" ? "Claude Code" : "Codex"
  return `${label} account "${active.name}" is at ${Math.round(used)}% of its window — "${best.name}" is at ${Math.round(best.usedPercent)}%. Switch in Settings → Agents.`
}
