import { homedir } from "node:os"
import { join } from "node:path"
import { probeOpenFiles } from "../open-files-probe.js"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../process-probe.js"

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

function sessions(paths: string[]): ProviderActivitySession[] {
  return paths.map((path) => ({ path, status: "active" }))
}

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
    return { kind: "available", sessions: sessions(result.paths) }
  },
}
