import type { ThreadRef } from "@mako/sessions"
import type { ProviderCapability } from "./registry.js"

export function applyProviderProcessActivity(
  ref: ThreadRef,
  activePaths: ReadonlySet<string>
): ThreadRef {
  return activePaths.has(ref.path) ? { ...ref, active: true } : ref
}

export interface ProviderProcessProbe extends ProviderCapability {
  activeSessionPaths(): Promise<string[]>
}
