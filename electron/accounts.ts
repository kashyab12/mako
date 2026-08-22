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
 * a classified state, not an error toast — providers refresh their own token
 * the next time they run, and the number appears.
 *
 * Provider-specific parsing, capture, environment, and usage live in the
 * independent account capability registry. This file intentionally remains
 * the stable compatibility facade used by IPC and process launchers.
 */

import type {
  AccountHarness,
  AccountProvider,
  AccountUsage,
  HarnessAccount,
  SelectedAccount,
} from "./account-types.js"
import {
  childProcessEnv,
  readSelection,
  writeSelection,
} from "./accounts-common.js"
import type {
  ProviderAccountCapability,
  SelectableAccountCapability,
} from "./providers/account-capability.js"
import { providerHost } from "./providers/index.js"

export type {
  AccountHarness,
  AccountProvider,
  AccountUsage,
  ClassifiedUsageWindows,
  HarnessAccount,
  OpenCodeAuthType,
  SelectedAccount,
  UsageWindow,
} from "./account-types.js"
function selectableCapability(provider: string): SelectableAccountCapability {
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability || capability.mode !== "selectable") {
    throw new Error(`Provider ${provider} does not support account selection`)
  }
  return capability
}

async function capabilitySelection(
  capability: ProviderAccountCapability
): Promise<string | null> {
  return capability.mode === "selectable"
    ? readSelection(capability.provider)
    : null
}

/* ------------------------------------------------------------ listing */

export async function listAccounts(): Promise<HarnessAccount[]> {
  const accounts: HarnessAccount[] = []
  for (const capability of providerHost.accountCapabilities.list()) {
    accounts.push(
      ...(await capability.listAccounts(await capabilitySelection(capability)))
    )
  }
  return accounts
}

/* ------------------------------------------------------------ capture */

/**
 * Capture the harness's *current* login as a named account.
 *
 * Sign into the other account with the CLI the ordinary way, capture, and
 * switch back — browser OAuth is a dance only the CLI itself can drive.
 */
export async function captureAccount(
  harness: AccountHarness,
  name: string
): Promise<void> {
  await selectableCapability(harness).captureAccount(name)
}

export async function removeAccount(
  harness: AccountHarness,
  name: string
): Promise<void> {
  const capability = selectableCapability(harness)
  if ((await readSelection(harness)) === name)
    await selectAccount(harness, null)
  await capability.removeAccount(name)
}

/* ------------------------------------------------------------ selection */

/** `null` selects the CLI's own login (the real home, untouched). */
export async function selectAccount(
  harness: AccountHarness,
  name: string | null
): Promise<void> {
  selectableCapability(harness)
  await writeSelection(harness, name)
}

/**
 * The environment for spawning a provider CLI under the selected account.
 *
 * Applied by every spawn path — headless drivers, fresh continuations, ACP —
 * so "switch account" means every future run, not some of them. Providers
 * strip auth env vars that could override the chosen isolated credentials.
 * Providers without account support keep the default account and environment.
 */
export async function accountEnv(
  provider: string,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const env = childProcessEnv(base)
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability) return env
  return capability.accountEnv(await capabilitySelection(capability), env)
}

export async function selectedAccount(
  provider: string
): Promise<SelectedAccount> {
  const capability = providerHost.accountCapabilities.get(provider)
  if (!capability) return { name: "default" }
  const selection = await capabilitySelection(capability)
  const env = await capability.accountEnv(
    selection,
    childProcessEnv(process.env)
  )
  return capability.selectedAccount(selection, env)
}

/* ------------------------------------------------------------ usage */

const usageCache = new Map<string, { at: number; usage: AccountUsage }>()
const USAGE_CACHE_MS = 60_000

export async function accountUsage(
  provider: AccountProvider,
  name: string
): Promise<AccountUsage> {
  const key = `${provider}:${name}`
  const cached = usageCache.get(key)
  if (cached && Date.now() - cached.at < USAGE_CACHE_MS) return cached.usage
  const capability = providerHost.accountCapabilities.get(provider)
  const usage = capability
    ? await capability.accountUsage(name)
    : {
        status: "unavailable" as const,
        detail: `Native usage is unavailable for ${provider}`,
      }
  usageCache.set(key, { at: Date.now(), usage })
  return usage
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
  const capability = selectableCapability(harness)
  suggestedAt.set(harness, Date.now())
  return `${capability.suggestionLabel} account "${active.name}" is at ${Math.round(used)}% of its window — "${best.name}" is at ${Math.round(best.usedPercent)}%. Switch in Settings → Agents.`
}
