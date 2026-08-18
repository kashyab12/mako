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

async function devinAccounts(): Promise<DevinAccount[]> {
  try {
    const raw = await readFile(join(homedir(), ".mako", "devin.json"), "utf8")
    const parsed = JSON.parse(raw) as { accounts?: DevinAccount[] }
    return Array.isArray(parsed.accounts) ? parsed.accounts : []
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true })

  const catalog = defaultCatalog({
    cachePath: join(dir, "syncd-catalog.json"),
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
