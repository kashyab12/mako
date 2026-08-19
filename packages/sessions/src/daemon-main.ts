/**
 * The daemon's entry point: `node dist/daemon-main.js`.
 *
 * Also happy under `ELECTRON_RUN_AS_NODE=1 <electron> dist/daemon-main.js`,
 * which is how the desktop app launches it — the app ships a Node runtime
 * already, and shipping a second one to run forty lines would be absurd.
 *
 * Keeps its cache in Mako's state directory and exits quietly if a daemon
 * is already serving —
 * every launcher can "start the daemon" unconditionally and exactly one
 * survives.
 */

import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { defaultCatalog } from "./index.js"
import { daemonSocketPath, serveCatalog } from "./daemon.js"
async function main(): Promise<void> {
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true })

  const catalog = defaultCatalog({
    cachePath: join(dir, "syncd-catalog.json"),
    // The daemon owns the durable copy: every session it ever sees is also
    // written here, and survives its native store being pruned or deleted.
    archivePath: join(dir, "archive"),
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
