import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { createServer } from "vite"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { webHostProxy } from "./web-dev-proxy.mjs"

// ORCA: Electron-based hosts leak this. If it stays set, Electron boots as Node
// and `require("electron")` is the npm stub instead of the real API.
delete process.env.ELECTRON_RUN_AS_NODE

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const web = process.argv.includes("--web")
const socketDirectory = web
  ? await mkdtemp(join(tmpdir(), "mako-web-"))
  : undefined
if (socketDirectory) await chmod(socketDirectory, 0o700)
const socket = socketDirectory ? join(socketDirectory, "host.sock") : undefined
const server = await createServer({
  plugins: socket ? [webHostProxy(socket)] : [],
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
  throw new Error("Vite did not expose a local development URL")
}

const hostEnvironment = { ...process.env, VITE_DEV_SERVER_URL: url }
if (socket) hostEnvironment.MAKO_WEB_SOCKET = socket
const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  cwd: root,
  env: hostEnvironment,
})
let stopping = false

async function stop(code, signal) {
  if (stopping) return
  stopping = true
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal ?? "SIGTERM")
  }
  await server.close()
  if (socketDirectory)
    await rm(socketDirectory, { recursive: true, force: true })
  process.exitCode = code
}

child.on("exit", (code, signal) => {
  void stop(signal ? 1 : (code ?? 0))
})
process.once("SIGINT", () => void stop(130, "SIGINT"))
process.once("SIGTERM", () => void stop(143, "SIGTERM"))
