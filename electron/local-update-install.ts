import { fork } from "node:child_process"
import { cp, lstat, mkdtemp } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyLocalCandidate } from "./local-updates.js"
import { resolveExecutable } from "./executable.js"

export async function prepareLocalInstall(
  candidate: { app: string; identity: string },
  receipt: string
) {
  const node = resolveExecutable("node")
  if (!node)
    throw new Error("Node.js is required to complete this local update.")
  const target = await lstat("/Applications/Mako.app")
  if (!target.isDirectory() || target.isSymbolicLink())
    throw new Error(
      "Install Mako in /Applications before using in-app updates."
    )
  const staging = await mkdtemp("/Applications/.mako-update-")
  const app = join(staging, "Mako.app")
  await cp(candidate.app, app, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  })
  await verifyLocalCandidate(app, candidate.identity)
  const script = join(staging, "installer.mjs")
  await cp(
    join(dirname(fileURLToPath(import.meta.url)), "local-update-installer.js"),
    script
  )
  const child = fork(
    script,
    [staging, candidate.identity, String(process.pid), receipt],
    {
      execPath: node,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
    }
  )
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(
        new Error("The installer did not become ready. Mako is still running.")
      )
    }, 70_000)
    child.once("message", (message) => {
      clearTimeout(timer)
      if (message === "ready") resolve()
      else reject(new Error("The installer returned an invalid response."))
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", () => {
      clearTimeout(timer)
      reject(new Error("The installer exited before it was ready."))
    })
  })
  return {
    install() {
      if (!child.connected)
        throw new Error("The prepared installer is no longer running.")
      child.send("install")
      child.unref()
    },
    cancel() {
      child.kill()
    },
  }
}
