import type { Harness } from "@/lib/types"

export const HARNESS_LABEL = Object.fromEntries([
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["grok", "Grok"],
  ["devin", "Devin"],
])

export function harnessLabel(harness: Harness): string {
  return HARNESS_LABEL[harness] ?? harness
}
