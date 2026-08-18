import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { UsageSummary, UsageTotals } from "./shared.js"

/**
 * What this has cost.
 *
 * Read from the session files rather than from a service, because that is
 * where the truth already is: every priced message carries the model and what
 * it cost, and no account, no backend and no network is needed to add them up.
 *
 * This is spend, not billing. Billing means a payment method and an account
 * model, which is a product decision and a server; it is not something to
 * imply by putting a currency symbol on a page. What is here is the question
 * people actually ask — *where did the money go* — answered exactly.
 */

/** Sessions read per scan. Enough for months of use, bounded for a first run. */
const MAX_FILES = 1500

/** Files bigger than this are read anyway but are the reason for the cap. */
const DAYS = 30

interface Bucket extends UsageTotals {
  key: string
}

function empty(key: string): Bucket {
  return { key, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
}

function add(bucket: Bucket, usage: RawUsage) {
  bucket.cost += usage.cost?.total ?? 0
  bucket.input += usage.input ?? 0
  bucket.output += usage.output ?? 0
  bucket.cacheRead += usage.cacheRead ?? 0
  bucket.cacheWrite += usage.cacheWrite ?? 0
  bucket.messages += 1
}

interface RawUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total?: number }
}

function totalsOf(bucket: Bucket): UsageTotals {
  const { key: _key, ...totals } = bucket
  return totals
}

/**
 * Aggregate every session on disk.
 *
 * The cheap test comes first — a line without `"usage"` in it cannot carry
 * one — so most of a session file is a substring search rather than a JSON
 * parse. That is what makes scanning a thousand sessions take a moment rather
 * than a minute.
 */
export async function usageSummary(sessionsRoot: string): Promise<UsageSummary> {
  const files: string[] = []
  try {
    for (const dir of await readdir(sessionsRoot)) {
      const path = join(sessionsRoot, dir)
      if (!(await stat(path)).isDirectory()) continue
      for (const name of await readdir(path)) {
        if (name.endsWith(".jsonl")) files.push(join(path, name))
      }
    }
  } catch {
    return blank()
  }

  // Newest first, so a cap cuts the oldest history rather than the useful part.
  files.sort().reverse()
  const truncated = files.length > MAX_FILES
  const chosen = files.slice(0, MAX_FILES)

  const total = empty("total")
  const days = new Map<string, Bucket>()
  const models = new Map<string, Bucket>()
  const projects = new Map<string, Bucket>()
  let sessions = 0

  for (const file of chosen) {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      continue
    }
    sessions += 1

    // The header line carries the project; it is always first.
    let cwd = "unknown"
    const firstBreak = text.indexOf("\n")
    if (firstBreak > 0) {
      try {
        const header = JSON.parse(text.slice(0, firstBreak)) as { cwd?: string }
        if (header.cwd) cwd = header.cwd
      } catch {
        // A session without a readable header still has priced messages.
      }
    }

    for (const line of text.split("\n")) {
      if (!line || !line.includes('"usage"')) continue
      let entry: {
        timestamp?: string
        message?: { usage?: RawUsage; model?: string; timestamp?: number }
      }
      try {
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      const usage = entry.message?.usage
      if (!usage) continue

      add(total, usage)

      const model = entry.message?.model ?? "unknown"
      const modelBucket = models.get(model) ?? empty(model)
      add(modelBucket, usage)
      models.set(model, modelBucket)

      const projectBucket = projects.get(cwd) ?? empty(cwd)
      add(projectBucket, usage)
      projects.set(cwd, projectBucket)

      // The *entry* carries an ISO timestamp and the message carries an epoch
      // one; the entry's is the reliable one. Reading only the message's put
      // every priced turn in history on today's date, which made the daily
      // chart a single bar and looked like there was no history at all.
      const date = dayOf(entry.timestamp, entry.message?.timestamp)
      const dayBucket = days.get(date) ?? empty(date)
      add(dayBucket, usage)
      days.set(date, dayBucket)
    }
  }

  const recent = [...days.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(-DAYS)

  return {
    total: totalsOf(total),
    days: recent.map((bucket) => ({ date: bucket.key, ...totalsOf(bucket) })),
    models: rank(models).map((bucket) => ({ model: bucket.key, ...totalsOf(bucket) })),
    projects: rank(projects).map((bucket) => ({ cwd: bucket.key, ...totalsOf(bucket) })),
    sessions,
    truncated,
  }
}

/** The day a turn happened, from whichever stamp the entry actually has. */
function dayOf(iso: string | undefined, epoch: number | undefined): string {
  if (typeof iso === "string" && iso.length >= 10) {
    const parsed = Date.parse(iso)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  }
  if (typeof epoch === "number" && epoch > 0) return new Date(epoch).toISOString().slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

/** Most expensive first: that is the order the question is asked in. */
function rank(buckets: Map<string, Bucket>): Bucket[] {
  return [...buckets.values()].sort((a, b) => b.cost - a.cost).slice(0, 12)
}

function blank(): UsageSummary {
  return {
    total: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 },
    days: [],
    models: [],
    projects: [],
    sessions: 0,
    truncated: false,
  }
}
