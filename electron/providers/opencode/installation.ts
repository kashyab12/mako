import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

export interface OpenCodeInstallation {
  command: string
  generation: "v1" | "v2"
}

export function openCodeInstallation(
  preferred?: OpenCodeInstallation["generation"]
): OpenCodeInstallation | null {
  const configured = process.env.OPENCODE_BIN_PATH
  if (configured && existsSync(configured)) {
    const installation: OpenCodeInstallation = {
      command: configured,
      generation: basename(configured).toLowerCase().startsWith("opencode2")
        ? "v2"
        : "v1",
    }
    if (!preferred || installation.generation === preferred) return installation
  }
  const configuredV2 = process.env.OPENCODE2_BIN_PATH
  const v2 =
    configuredV2 && existsSync(configuredV2)
      ? configuredV2
      : join(homedir(), ".opencode", "bin", "opencode2")
  const configuredV1 = process.env.OPENCODE1_BIN_PATH
  const v1 =
    configuredV1 && existsSync(configuredV1)
      ? configuredV1
      : join(homedir(), ".opencode", "bin", "opencode")
  if (preferred === "v1") {
    return existsSync(v1) ? { command: v1, generation: "v1" } : null
  }
  if (preferred === "v2") {
    return existsSync(v2) ? { command: v2, generation: "v2" } : null
  }
  if (existsSync(v2)) return { command: v2, generation: "v2" }
  return existsSync(v1) ? { command: v1, generation: "v1" } : null
}

export function openCodeExecutable(): string | null {
  return openCodeInstallation()?.command ?? null
}

export async function openCodeSessionGeneration(
  sessionId: string
): Promise<OpenCodeInstallation["generation"]> {
  const sqlite = await import("node:sqlite").catch(() => null)
  if (!sqlite) return openCodeInstallation()?.generation ?? "v1"
  for (const name of ["opencode.db", "opencode-next.db"]) {
    const path = join(homedir(), ".local", "share", "opencode", name)
    if (!existsSync(path)) continue
    let database: import("node:sqlite").DatabaseSync | undefined
    try {
      database = new sqlite.DatabaseSync(path, { readOnly: true })
      const tables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name)
      )
      if (
        tables.has("session_v2") &&
        database.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(sessionId)
      ) {
        return "v2"
      }
      if (
        tables.has("session") &&
        database.prepare("SELECT 1 FROM session WHERE id = ?").get(sessionId)
      ) {
        return name === "opencode-next.db" ? "v2" : "v1"
      }
    } catch {
      continue
    } finally {
      database?.close()
    }
  }
  return openCodeInstallation()?.generation ?? "v1"
}
