import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

// ORCA: Electron-based hosts leak this. If it stays set, Electron boots as Node
// and `require("electron")` is the npm stub instead of the real API.
delete process.env.ELECTRON_RUN_AS_NODE

const require = createRequire(import.meta.url)
const electronPath = require("electron")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  cwd: root,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173",
  },
})

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
