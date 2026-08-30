import type { ProviderCapability } from "./registry.js"

export type ProviderActivityStatus = "active" | "needs-input"

export interface ProviderActivitySession {
  nativeId?: string
  path?: string
  status: ProviderActivityStatus
  detail?: string
}

export type ProviderActivityResult =
  | { kind: "available"; sessions: ProviderActivitySession[] }
  | {
      kind: "unavailable"
      reason: "unsupported" | "timeout" | "permission" | "failed"
    }

export interface ProviderProcessProbe extends ProviderCapability {
  pollIntervalMs?: number
  staleAfterMs?: number
  timeoutMs?: number
  probe(signal: AbortSignal): Promise<ProviderActivityResult>
}
