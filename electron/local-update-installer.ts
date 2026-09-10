import { execFile } from "node:child_process"
import { lstat, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
interface PreparedApplication {
  staging: string
  target: string
  verify(path: string): Promise<void>
}

export async function replacePreparedApplication(
  input: PreparedApplication
): Promise<string> {
  const candidate = join(input.staging, "Mako.app")
  const backup = join(input.staging, "Previous Mako.app")
  const current = await lstat(input.target)
  if (!current.isDirectory() || current.isSymbolicLink())
    throw new Error("The installed app is not a regular application directory")
  await input.verify(candidate)
  await rename(input.target, backup)
  try {
    await rename(candidate, input.target)
    await input.verify(input.target)
  } catch (error) {
    const failed = await lstat(input.target).catch(
      (failure: NodeJS.ErrnoException) => {
        if (failure.code === "ENOENT") return null
        throw failure
      }
    )
    if (failed)
      await rename(input.target, join(input.staging, "Failed Mako.app"))
    await rename(backup, input.target)
    throw error
  }
  return backup
}

async function runInstaller(): Promise<void> {
  const [staging, identity, pidText, receipt] = process.argv.slice(2)
  if (
    !staging ||
    !/^\/Applications\/\.mako-update-[a-zA-Z0-9]+$/.test(staging) ||
    !identity ||
    !/^[a-fA-F0-9]{40}$/.test(identity) ||
    !pidText ||
    !/^\d+$/.test(pidText) ||
    !receipt
  )
    throw new Error("Invalid local installer arguments")
  const target = "/Applications/Mako.app"
  const hostPid = Number(pidText)
  let authorized = false
  const verify = async (path: string) => {
    await execute(
      "codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "--test-requirement",
        `=identifier "dev.mako.app" and certificate leaf = H"${identity}"`,
        path,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 }
    )
  }
  try {
    const directory = await lstat(staging)
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o077
    )
      throw new Error("The install staging directory is not private")
    await verify(join(staging, "Mako.app"))
    process.send?.("ready")
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The host did not authorize installation")),
        60_000
      )
      process.once("message", (message) => {
        clearTimeout(timer)
        if (message === "install") resolve()
        else reject(new Error("Invalid installation authorization"))
      })
      process.once("disconnect", () => {
        clearTimeout(timer)
        reject(
          new Error("The host disconnected without authorizing installation")
        )
      })
    })
    authorized = true
    process.disconnect?.()
    const deadline = Date.now() + 60_000
    for (;;) {
      let hostAlive = true
      try {
        process.kill(hostPid, 0)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          hostAlive = false
        else throw error
      }
      const { stdout } = await execute("ps", ["-axo", "comm="], {
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      if (
        !hostAlive &&
        !stdout
          .split("\n")
          .some((line) => line.trim().startsWith(`${target}/Contents/`))
      )
        break
      if (Date.now() >= deadline)
        throw new Error("Mako processes are still running")
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const backup = await replacePreparedApplication({ staging, target, verify })
    await writeFile(receipt, JSON.stringify({ ok: true, backup }), {
      mode: 0o600,
    })
    await execute("open", [target], { timeout: 10_000 })
  } catch {
    if (authorized) {
      await writeFile(
        receipt,
        JSON.stringify({
          ok: false,
          message:
            "The update could not be installed. The previous app was retained. Close other Mako instances and try again.",
        }),
        { mode: 0o600 }
      )
      await execute("open", [target], { timeout: 10_000 })
    }
    process.exitCode = 1
    if (process.connected) process.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runInstaller().catch(() => {
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
