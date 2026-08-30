import { homedir } from "node:os"
import { join } from "node:path"
import { probeOpenFiles } from "../open-files-probe.js"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../process-probe.js"

export function parseCursorOpenSessionPaths(
  output: string,
  roots: string[]
): string[] {
  const prefixes = roots.map((root) => `n${root.replace(/[\\/]$/, "")}/`)
  return [
    ...new Set(
      output
        .split("\n")
        .filter(
          (line) =>
            line.endsWith("/store.db") &&
            prefixes.some((prefix) => line.startsWith(prefix))
        )
        .map((line) => line.slice(1))
    ),
  ]
}

function sessions(paths: string[]): ProviderActivitySession[] {
  return paths.map((path) => ({ path, status: "active" }))
}

export const cursorProcessProbe: ProviderProcessProbe = {
  provider: "cursor",
  staleAfterMs: 15_000,
  async probe(signal) {
    const home = homedir()
    const roots = [
      join(home, ".cursor", "chats"),
      join(home, ".cursor", "acp-sessions"),
    ]
    const prefixes = roots.map(
      (root) => `${root.replace(/[\\/]$/, "")}/`
    )
    const result = await probeOpenFiles({
      processNames: ["cursor-agent", "Cursor"],
      signal,
      accept: (path) =>
        path.endsWith("/store.db") &&
        prefixes.some((prefix) => path.startsWith(prefix)),
    })
    if (result.kind === "unavailable") return result
    return { kind: "available", sessions: sessions(result.paths) }
  },
}
