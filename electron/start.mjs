import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createServer } from "vite"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { webHostProxy } from "./web-dev-proxy.mjs"
import { manualDevUpdates } from "./dev-updates.mjs"
import { createHash } from "node:crypto"

// ORCA: Electron-based hosts leak this. If it stays set, Electron boots as Node
// and `require("electron")` is the npm stub instead of the real API.
delete process.env.ELECTRON_RUN_AS_NODE

/** The host asks to come back on the current build with this exit code. */
const RELAUNCH_EXIT_CODE = 75

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const web = process.argv.includes("--web")
const hot = process.argv.includes("--hot")
const cacheDirectory = await mkdtemp(join(tmpdir(), "mako-vite-"))
const socketDirectory = await mkdtemp(join(tmpdir(), "mako-web-"))
await chmod(socketDirectory, 0o700)
const socket = join(socketDirectory, "host.sock")
const server = await createServer({
  cacheDir: cacheDirectory,
  define: { "import.meta.env.MAKO_MANUAL_RELOAD": JSON.stringify(!hot) },
  plugins: [webHostProxy(socket), ...(!hot ? [manualDevUpdates()] : [])],
  root,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
  },
})
await server.listen()
server.printUrls()
const url = server.resolvedUrls?.local[0]
if (!url) {
  await server.close()
  await rm(cacheDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  throw new Error("Vite did not expose a local development URL")
}

// The renderer hot-reloads through Vite; the host cannot. Keeping the host
// compiler running means an edit under electron/ is on disk by the time the
// window says "rebuilt", and Restart Mako loads it without leaving the desk.
const compiler = spawn(
  process.execPath,
  [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.electron.json",
    "--watch",
    "--preserveWatchOutput",
  ],
  { stdio: "inherit", cwd: root }
)

const profile = process.env.MAKO_PROFILE || `dev-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`
const hostEnvironment = {
  ...process.env,
  VITE_DEV_SERVER_URL: url,
  MAKO_PROFILE: profile,
  MAKO_WEB_SOCKET: socket,
  MAKO_WEB_ONLY: web ? "1" : "0",
}
console.log(`[mako-dev] ${profile} · ${hot ? "automatic hot updates" : "manual reload"} · ${url}`)
let child
let stopping = false

function launch() {
  child = spawn(electronPath, ["."], {
    stdio: "inherit",
    cwd: root,
    env: hostEnvironment,
  })
  child.on("exit", (code, signal) => {
    if (code === RELAUNCH_EXIT_CODE && !stopping) {
      launch()
      return
    }
    void stop(signal ? 1 : (code ?? 0))
  })
}

async function stop(code, signal) {
  if (stopping) return
  stopping = true
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal ?? "SIGTERM")
  }
  if (compiler.exitCode === null && compiler.signalCode === null) {
    compiler.kill("SIGTERM")
  }
  await server.close()
  if (socketDirectory)
    await rm(socketDirectory, { recursive: true, force: true })
  await rm(cacheDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  process.exitCode = code
}

launch()
process.once("SIGINT", () => void stop(130, "SIGINT"))
process.once("SIGTERM", () => void stop(143, "SIGTERM"))
