/**
 * The daemon's entry point: `node dist/daemon-main.js`.
 *
 * Also happy under `ELECTRON_RUN_AS_NODE=1 <electron> dist/daemon-main.js`,
 * which is how the desktop app launches it — the app ships a Node runtime
 * already, and shipping a second one to run forty lines would be absurd.
 *
 * Reads the same config files the app reads (Devin accounts), keeps its
 * cache beside them, and exits quietly if a daemon is already serving —
 * every launcher can "start the daemon" unconditionally and exactly one
 * survives.
 */

import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { defaultCatalog } from "./index.js"
import { daemonSocketPath, serveCatalog } from "./daemon.js"
import type { DevinAccount } from "./providers/devin.js"

type JsonScalar = boolean | number | string | null
type JsonValue = JsonScalar | JsonRecord | JsonValue[]

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

async function devinAccounts(): Promise<DevinAccount[]> {
  try {
    const raw = await readFile(join(homedir(), ".mako", "devin.json"), "utf8")
    return parseDevinAccounts(raw)
  } catch {
    return []
  }
}

function parseDevinAccounts(raw: string): DevinAccount[] {
  const root = parseJsonRecord(raw)
  if (!root) return []
  const value = root["accounts"]
  if (!Array.isArray(value)) return []
  const accounts: DevinAccount[] = []
  for (const candidate of value) {
    if (!isJsonRecord(candidate)) continue
    const name = readString(candidate, "name")
    const apiKey = readString(candidate, "apiKey")
    if (!name || !apiKey) continue
    const account: DevinAccount = { name, apiKey }
    const apiUrl = readString(candidate, "apiUrl")
    if (apiUrl !== undefined) account.apiUrl = apiUrl
    accounts.push(account)
  }
  return accounts
}

function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    const value: JsonValue = JSON.parse(raw)
    return isJsonRecord(value) ? value : null
  } catch {
    return null
  }
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return Object.prototype.toString.call(value) === "[object Object]"
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return Object.prototype.toString.call(value) === "[object String]" ? String(value) : undefined
}

async function main(): Promise<void> {
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true })

  const catalog = defaultCatalog({
    cachePath: join(dir, "syncd-catalog.json"),
    // The daemon owns the durable copy: every session it ever sees is also
    // written here, and survives its native store being pruned or deleted.
    archivePath: join(dir, "archive"),
    devinAccounts: await devinAccounts(),
  })

  const started = performance.now()
  const refs = await catalog.scan()
  catalog.startWatching()

  try {
    await serveCatalog(catalog, daemonSocketPath())
  } catch (error) {
    // Another daemon won the race. Not a failure — the job is being done.
    console.log(String(error instanceof Error ? error.message : error))
    catalog.stop()
    process.exit(0)
  }

  console.log(
    `mako-syncd: ${refs.length} sessions in ${Math.round(performance.now() - started)}ms, watching · ${daemonSocketPath()}`
  )

  const stop = () => {
    catalog.stop()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

void main()
