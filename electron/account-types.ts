/** Account discovery is registry-driven, so provider modules may add more ids. */
export type AccountHarness = string
export type AccountProvider = string
export type OpenCodeAuthType = "oauth" | "api" | "wellknown"

export interface HarnessAccount {
  harness: AccountProvider
  name: string
  /** The login's actual identity — the email a human recognizes. */
  email?: string
  accountId?: string
  providerId?: string
  authType?: OpenCodeAuthType
  /** The isolated config home this account materializes as. */
  dir: string
  active: boolean
  /** Where the login came from: captured here, or found in a provider config. */
  source?: "mako" | "subrouter" | "opencode"
}

export interface UsageWindow {
  usedPercent: number
  windowMinutes: number
  /** Unix ms when the window resets, when the provider says. */
  resetsAt: number | null
}

export interface AccountUsage {
  status: "ok" | "stale-token" | "missing-credentials" | "unavailable" | "error"
  plan?: string
  session?: UsageWindow | null
  weekly?: UsageWindow | null
  detail?: string
}

export interface ClassifiedUsageWindows {
  session: UsageWindow | null
  weekly: UsageWindow | null
}

export interface SelectedAccount {
  name: string
  dir?: string
}
