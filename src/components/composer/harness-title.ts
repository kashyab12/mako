export function harnessTitle(harness: string): string {
  switch (harness) {
    case "claude":
      return "Claude Code"
    case "codex":
      return "Codex"
    case "cursor":
      return "Cursor"
    case "grok":
      return "Grok"
    case "devin":
      return "Devin"
    case "opencode":
      return "OpenCode"
    default:
      return harness
  }
}
