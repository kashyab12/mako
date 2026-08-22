import type {
  AccountUsage,
  HarnessAccount,
  SelectedAccount,
} from "../account-types.js"
import type { ProviderCapability } from "./registry.js"

interface AccountCapabilityBase extends ProviderCapability {
  /** Discover only public account metadata; credentials never cross this boundary. */
  listAccounts(selection: string | null): Promise<HarnessAccount[]>
  /** Apply provider-owned credential isolation to a fresh environment copy. */
  accountEnv(
    selection: string | null,
    base: NodeJS.ProcessEnv
  ): Promise<NodeJS.ProcessEnv>
  selectedAccount(
    selection: string | null,
    env: NodeJS.ProcessEnv
  ): SelectedAccount
  accountUsage(name: string): Promise<AccountUsage>
}

export interface SelectableAccountCapability extends AccountCapabilityBase {
  mode: "selectable"
  suggestionLabel: string
  captureAccount(name: string): Promise<void>
  removeAccount(name: string): Promise<void>
}

export interface ObservedAccountCapability extends AccountCapabilityBase {
  mode: "observed"
}

/**
 * An independent provider capability, rather than optional account fields on
 * another transport. Providers either register this complete contract or use
 * the host's default account/environment behavior.
 */
export type ProviderAccountCapability =
  SelectableAccountCapability | ObservedAccountCapability
