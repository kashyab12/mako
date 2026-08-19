import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
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
  return {
    key,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    messages: 0,
  }
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

interface UsageEntry {
  timestamp?: string
  messageTimestamp?: number
  model?: string
  usage: RawUsage
}

function totalsOf(bucket: Bucket): UsageTotals {
  return {
    cost: bucket.cost,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    messages: bucket.messages,
  }
}

/**
 * Aggregate every session on disk.
 *
 * The cheap test comes first — a line without `"usage"` in it cannot carry
 * one — so most of a session file is a substring search rather than a JSON
 * parse. That is what makes scanning a thousand sessions take a moment rather
 * than a minute.
 */
export async function usageSummary(
  sessionsRoot: string
): Promise<UsageSummary> {
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
        cwd = parseSessionCwd(text.slice(0, firstBreak)) ?? cwd
      } catch {
        // A session without a readable header still has priced messages.
      }
    }

    for (const line of text.split("\n")) {
      if (!line || !line.includes('"usage"')) continue
      let entry: UsageEntry | null
      try {
        entry = parseUsageEntry(line)
      } catch {
        continue
      }
      if (!entry) continue

      add(total, entry.usage)

      const model = entry.model ?? "unknown"
      const modelBucket = models.get(model) ?? empty(model)
      add(modelBucket, entry.usage)
      models.set(model, modelBucket)

      const projectBucket = projects.get(cwd) ?? empty(cwd)
      add(projectBucket, entry.usage)
      projects.set(cwd, projectBucket)

      // The *entry* carries an ISO timestamp and the message carries an epoch
      // one; the entry's is the reliable one. Reading only the message's put
      // every priced turn in history on today's date, which made the daily
      // chart a single bar and looked like there was no history at all.
      const date = dayOf(entry.timestamp, entry.messageTimestamp)
      const dayBucket = days.get(date) ?? empty(date)
      add(dayBucket, entry.usage)
      days.set(date, dayBucket)
    }
  }

  const recent = [...days.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(-DAYS)

  return {
    total: totalsOf(total),
    days: recent.map((bucket) => ({ date: bucket.key, ...totalsOf(bucket) })),
    models: rank(models).map((bucket) => ({
      model: bucket.key,
      ...totalsOf(bucket),
    })),
    projects: rank(projects).map((bucket) => ({
      cwd: bucket.key,
      ...totalsOf(bucket),
    })),
    sessions,
    truncated,
  }
}

function parseSessionCwd(line: string): string | undefined {
  const value: JsonValue = JSON.parse(line)
  if (!isJsonObject(value)) return undefined
  return stringValue(value.cwd) || undefined
}

function parseUsageEntry(line: string): UsageEntry | null {
  const value: JsonValue = JSON.parse(line)
  const root = objectValue(value)
  const message = objectValue(root?.message)
  const usageValue = objectValue(message?.usage)
  if (!root || !message || !usageValue) return null

  const usage: RawUsage = {}
  assignNumber(usage, "input", usageValue.input)
  assignNumber(usage, "output", usageValue.output)
  assignNumber(usage, "cacheRead", usageValue.cacheRead)
  assignNumber(usage, "cacheWrite", usageValue.cacheWrite)

  const costValue = objectValue(usageValue.cost)
  const total = numberValue(costValue?.total)
  if (total !== undefined) usage.cost = { total }

  const entry: UsageEntry = { usage }
  const timestamp = stringValue(root.timestamp)
  if (timestamp !== undefined) entry.timestamp = timestamp
  const messageTimestamp = numberValue(message.timestamp)
  if (messageTimestamp !== undefined) entry.messageTimestamp = messageTimestamp
  const model = stringValue(message.model)
  if (model !== undefined) entry.model = model
  return entry
}

function assignNumber(
  target: RawUsage,
  key: "input" | "output" | "cacheRead" | "cacheWrite",
  value: JsonValue | undefined
): void {
  const parsed = numberValue(value)
  if (parsed !== undefined) target[key] = parsed
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return isNumber(value) ? value : undefined
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

/** The day a turn happened, from whichever stamp the entry actually has. */
function dayOf(iso: string | undefined, epoch: number | undefined): string {
  if (iso !== undefined && iso.length >= 10) {
    const parsed = Date.parse(iso)
    if (!Number.isNaN(parsed))
      return new Date(parsed).toISOString().slice(0, 10)
  }
  if (epoch !== undefined && epoch > 0)
    return new Date(epoch).toISOString().slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

/** Most expensive first: that is the order the question is asked in. */
function rank(buckets: Map<string, Bucket>): Bucket[] {
  return [...buckets.values()].sort((a, b) => b.cost - a.cost).slice(0, 12)
}

function blank(): UsageSummary {
  return {
    total: {
      cost: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      messages: 0,
    },
    days: [],
    models: [],
    projects: [],
    sessions: 0,
    truncated: false,
  }
}
