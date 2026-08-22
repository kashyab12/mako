import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function devinExecutable(): string | null {
  const configured = process.env.DEVIN_CLI_PATH
  if (configured && existsSync(configured)) return configured
  const direct = join(homedir(), ".local", "bin", "devin")
  if (existsSync(direct)) return direct
  if (process.platform !== "darwin") return null
  const registry = join(
    homedir(),
    "Library",
    "Application Support",
    "Zed",
    "external_agents",
    "registry",
    "devin"
  )
  try {
    for (const version of readdirSync(registry).sort().reverse()) {
      const executable = join(registry, version, "bin", "devin")
      if (existsSync(executable)) return executable
    }
  } catch {
    return null
  }
  return null
}
