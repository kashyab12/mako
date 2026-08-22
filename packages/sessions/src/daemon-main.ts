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

import { chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Server } from "node:net"
import { defaultCatalog } from "./index.js"
import {
  claimDaemon,
  daemonSocketPath,
  serveCatalog,
  type DaemonClaim,
} from "./daemon.js"
async function main(): Promise<void> {
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const socketPath = daemonSocketPath()
  let claim: DaemonClaim
  try {
    claim = await claimDaemon(socketPath)
  } catch (error) {
    console.log(String(error instanceof Error ? error.message : error))
    return
  }

  const catalog = defaultCatalog({
    cachePath: join(dir, "syncd-catalog.json"),
    // The daemon owns the durable copy: every session it ever sees is also
    // written here, and survives its native store being pruned or deleted.
    archivePath: join(dir, "archive"),
  })

  const started = performance.now()
  let server: Server
  try {
    const refs = await catalog.scan()
    catalog.startWatching()
    server = await serveCatalog(catalog, socketPath, claim)
    console.log(
      `mako-syncd: ${refs.length} sessions in ${Math.round(performance.now() - started)}ms, watching · ${socketPath}`
    )
  } catch (error) {
    console.log(String(error instanceof Error ? error.message : error))
    catalog.stop()
    await claim.release()
    return
  }

  const stop = () => {
    catalog.stop()
    const timer = setTimeout(() => process.exit(0), 500)
    timer.unref?.()
    server.close(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

void main()
