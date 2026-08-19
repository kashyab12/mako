import type { Harness, ThreadRef } from "@/lib/types"

export const HARNESS_LABEL = Object.fromEntries([
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["devin", "Devin"],
])

/**
 * Legacy engine-owned sessions read as Devin conversations. Pi is an
 * implementation detail and never appears as a selectable agent.
 */
export function displayHarness(ref: ThreadRef): string {
  return ref.harness === "pi" ? "devin" : ref.harness
}

export function harnessLabel(harness: Harness): string {
  return HARNESS_LABEL[harness] ?? harness
}
