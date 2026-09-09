import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runtimeInfo } from "./runtime-connection.js"

export function runtimeLocation(dataRoot: string) {
  const identity = createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 16)
  const directory = join(tmpdir(), `mako-host-${identity}`)
  return { directory, socket: join(directory, "host.sock") }
}

export async function ensureRuntime(input: { dataRoot: string; executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
  const location = runtimeLocation(input.dataRoot)
  await mkdir(location.directory, { mode: 0o700, recursive: true })
  const directory = await lstat(location.directory)
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid()))
    throw new Error("The Mako host directory is not private to this user")
  const existing = await runtimeInfo(location.socket)
  if (existing) return { ...location, info: existing }
  const child = spawn(input.executable, input.args, {
    cwd: input.cwd, detached: true, stdio: "ignore",
    env: { ...input.env, MAKO_HOST_ONLY: "1", MAKO_DATA_ROOT: input.dataRoot, MAKO_WEB_SOCKET: location.socket, MAKO_WEB_ONLY: "1" },
  })
  let launchError: Error | undefined
  child.once("error", (error) => { launchError = error })
  child.unref()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const info = await runtimeInfo(location.socket)
    if (info) return { ...location, info }
    if (launchError) throw launchError
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`The shared Mako host did not become ready${child.exitCode === null ? "" : ` (exit ${child.exitCode})`}. An older Mako may still own this profile. No isolated replacement was started.`)
}
