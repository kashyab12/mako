import { homedir } from "node:os"
import { join } from "node:path"
import { CodexSessionActivity } from "./session-activity.js"
import { probeOpenFiles } from "../open-files-probe.js"
import type { ProviderProcessProbe } from "../process-probe.js"

export function parseCodexOpenSessionPaths(
  output: string,
  root: string
): string[] {
  const prefix = `n${root.replace(/[\\/]$/, "")}/`
  return [
    ...new Set(
      output
        .split("\n")
        .filter((line) => line.startsWith(prefix) && line.endsWith(".jsonl"))
        .map((line) => line.slice(1))
    ),
  ]
}

const activity = new CodexSessionActivity()

export const codexProcessProbe: ProviderProcessProbe = {
  provider: "codex",
  staleAfterMs: 15_000,
  async probe(signal) {
    const root = join(homedir(), ".codex", "sessions")
    const prefix = `${root.replace(/[\\/]$/, "")}/`
    const result = await probeOpenFiles({
      processNames: ["codex"],
      signal,
      accept: (path) => path.startsWith(prefix) && path.endsWith(".jsonl"),
    })
    if (result.kind === "unavailable") return result
    activity.retain(result.paths)
    const sessions = []
    // Keep reads bounded even when many idle app-server sessions remain open.
    for (let index = 0; index < result.paths.length; index += 4) {
      const batch = await Promise.all(
        result.paths
          .slice(index, index + 4)
          .map((path) => activity.read(path, signal))
      )
      sessions.push(...batch)
    }
    return { kind: "available", sessions }
  },
}
