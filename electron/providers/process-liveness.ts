import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
const START_TOLERANCE_MS = 30_000

export function processStartMatches(
  expected: number | string | undefined,
  actual: number
): boolean {
  if (expected === undefined) return true
  const numeric = Object.prototype.toString.call(expected) === "[object Number]"
  const parsed = numeric
    ? Number(expected) < 1_000_000_000_000
      ? Number(expected) * 1_000
      : Number(expected)
    : Date.parse(String(expected))
  return Number.isFinite(parsed) && Math.abs(parsed - actual) <= START_TOLERANCE_MS
}

export async function processIdentityMatches({
  pid,
  startedAt,
  signal,
}: {
  pid: number
  startedAt?: number | string
  signal: AbortSignal
}): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (startedAt === undefined || process.platform === "win32") return true
  try {
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "lstart="], {
      maxBuffer: 4_096,
      timeout: 1_500,
      signal,
    })
    const actual = Date.parse(stdout.trim())
    return Number.isFinite(actual) && processStartMatches(startedAt, actual)
  } catch {
    return true
  }
}
