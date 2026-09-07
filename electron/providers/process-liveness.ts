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
  return (
    Number.isFinite(parsed) && Math.abs(parsed - actual) <= START_TOLERANCE_MS
  )
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
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false
    throw error
  }
  if (startedAt === undefined) return true
  if (process.platform === "win32")
    throw new Error("Process start identity is unavailable on this platform")
  const { stdout } = await run("ps", ["-p", String(pid), "-o", "lstart="], {
    maxBuffer: 4_096,
    timeout: 1_500,
    signal,
  })
  const actual = Date.parse(stdout.trim())
  if (!Number.isFinite(actual))
    throw new Error("Process start time is unreadable")
  return processStartMatches(startedAt, actual)
}
