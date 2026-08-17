import { app } from "electron"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Crash reporting, on this machine only.
 *
 * Nothing here leaves the computer. That is a deliberate limit rather than an
 * unfinished one: an agent's window is full of the user's source, their prompts
 * and their tool output, so a crash report is not something to post anywhere by
 * default. What this gives instead is the thing that was actually missing — a
 * failure that leaves a trace you can find, read, and hand over on purpose.
 *
 * The seam for a remote sink is `write`: point it at a transport and every
 * report goes there too. Nothing else needs to change.
 */

export type CrashKind =
  | "main-uncaught"
  | "main-rejection"
  | "renderer-error"
  | "renderer-rejection"
  | "renderer-gone"
  | "child-gone"

export interface CrashReport {
  id: string
  kind: CrashKind
  at: string
  message: string
  stack?: string
  /** Where it came from, when the renderer can say. */
  source?: string
  app: { version: string; electron: string; chrome: string; node: string }
  os: { platform: string; arch: string; release: string }
  /** What the app was doing just before. */
  breadcrumbs: string[]
}

/** Reports kept on disk. Old ones are pruned so this cannot grow without end. */
const KEEP = 40

/**
 * A short trail of what happened before the crash.
 *
 * Deliberately small and deliberately not the payloads — channel names and
 * event types, never their arguments. A breadcrumb trail that carried the
 * arguments would be a log of the user's prompts and their source, which is
 * exactly what this file promises not to keep.
 */
const TRAIL = 40
const trail: string[] = []

export function breadcrumb(note: string) {
  trail.push(`${new Date().toISOString()} ${note}`)
  if (trail.length > TRAIL) trail.shift()
}

export function crashesDir() {
  return join(app.getPath("userData"), "crashes")
}

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    if (typeof record.message === "string") {
      return { message: record.message, stack: typeof record.stack === "string" ? record.stack : undefined }
    }
    try {
      return { message: JSON.stringify(error).slice(0, 2000) }
    } catch {
      return { message: String(error) }
    }
  }
  return { message: String(error) }
}

/** Sortable and unique enough without pulling in a uuid for a filename. */
let counter = 0
function nextId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${(counter += 1)}`
}

export function record(kind: CrashKind, error: unknown, source?: string): CrashReport {
  const { message, stack } = describe(error)
  const report: CrashReport = {
    id: nextId(),
    kind,
    at: new Date().toISOString(),
    message,
    stack,
    source,
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      node: process.versions.node ?? "",
    },
    os: { platform: process.platform, arch: process.arch, release: process.getSystemVersion?.() ?? "" },
    breadcrumbs: [...trail],
  }
  write(report)
  return report
}

function write(report: CrashReport) {
  try {
    const dir = crashesDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${report.id}.json`), JSON.stringify(report, null, 2), "utf8")
    prune(dir)
  } catch {
    // A crash reporter that throws while reporting a crash is worse than one
    // that quietly gives up; the console line below is the fallback.
  }
  console.error(`[crash:${report.kind}] ${report.message}\n${report.stack ?? ""}`)
}

function prune(dir: string) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
  for (const name of files.slice(0, Math.max(0, files.length - KEEP))) {
    try {
      rmSync(join(dir, name))
    } catch {
      // Nothing to do about a report we cannot delete.
    }
  }
}

export function listCrashes(): CrashReport[] {
  try {
    const dir = crashesDir()
    mkdirSync(dir, { recursive: true })
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse()
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), "utf8")) as CrashReport
        } catch {
          return null
        }
      })
      .filter((report): report is CrashReport => report !== null)
  } catch {
    return []
  }
}

export function clearCrashes() {
  try {
    rmSync(crashesDir(), { recursive: true, force: true })
  } catch {
    // Same as above: this is best effort by design.
  }
}

/**
 * Arm the main process.
 *
 * `uncaughtException` is handled rather than left to kill the process: in a
 * desktop app the alternative is the window vanishing with no explanation,
 * which is the exact failure this file exists to end. A caught exception is
 * recorded and the app carries on — degraded, but present and able to say so.
 */
export function installCrashReporting() {
  process.on("uncaughtException", (error) => {
    record("main-uncaught", error)
  })
  process.on("unhandledRejection", (reason) => {
    record("main-rejection", reason)
  })
  app.on("child-process-gone", (_event, details) => {
    record("child-gone", new Error(`${details.type} exited: ${details.reason}`))
  })
}
