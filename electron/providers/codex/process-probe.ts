import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { ProviderProcessProbe } from "../process-probe.js"

const run = promisify(execFile)
const LsofErrorSchema = z.object({
  code: z.union([z.number().int(), z.string()]).optional(),
})

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

export const codexProcessProbe: ProviderProcessProbe = {
  provider: "codex",
  async activeSessionPaths() {
    if (process.platform === "win32") return []
    const root = `${join(homedir(), ".codex", "sessions")}/`
    try {
      const command = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof"
      const { stdout } = await run(command, ["-Fn", "-c", "codex"], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 4_000,
      })
      return parseCodexOpenSessionPaths(stdout, root)
    } catch (error) {
      const parsed = LsofErrorSchema.safeParse(error)
      if (parsed.success && Number(parsed.data.code) === 1) return []
      throw error
    }
  },
}
