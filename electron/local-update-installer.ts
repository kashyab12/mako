import { execFile } from "node:child_process"
import {
  lstat,
  mkdtemp,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
interface PreparedApplication {
  staging: string
  target: string
  verify(path: string): Promise<void>
  ready(): Promise<void>
}

async function appStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
}

export async function replacePreparedApplication(
  input: PreparedApplication
): Promise<string | null> {
  const lockPath = `${input.target}.update-lock`
  const lock = await open(lockPath, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error(
          `Another installer owns ${lockPath}. No application files were changed. If a previous installer crashed, verify that it has stopped before removing its lock.`
        )
      throw error
    }
  )
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }))
    const candidate = join(input.staging, "Mako.app")
    const backup = join(input.staging, "Previous Mako.app")
    const current = await appStat(input.target)
    if (current && (!current.isDirectory() || current.isSymbolicLink()))
      throw new Error(
        "The installed app is not a regular application directory"
      )
    if (await appStat(backup))
      throw new Error(
        "This installation already has a backup. Use a new staging directory."
      )
    await input.verify(candidate)
    await input.ready()
    const latest = await appStat(input.target)
    if (current?.dev !== latest?.dev || current?.ino !== latest?.ino)
      throw new Error(
        "The installed application changed during preparation. Nothing was replaced."
      )
    if (current) await rename(input.target, backup)
    try {
      await rename(candidate, input.target)
      await input.verify(input.target)
    } catch (error) {
      try {
        if (await appStat(input.target)) {
          const failed = await mkdtemp(join(input.staging, "failed-"))
          await rename(input.target, join(failed, "Mako.app"))
        }
        if (current) await rename(backup, input.target)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Installation and rollback failed. The previous application is retained at ${backup}; do not remove that directory.`,
          { cause: rollbackError }
        )
      }
      throw error
    }
    return current ? backup : null
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

export function bundleProcessIds(output: string, bundle: string): number[] {
  const name = basename(bundle, ".app")
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) return []
    const command = match[2]!.trim()
    return command.startsWith(`${bundle}/Contents/`) ||
      command === name ||
      command.startsWith(`${name} Helper`)
      ? [Number(match[1])]
      : []
  })
}

export async function runningBundleProcesses(
  bundle: string
): Promise<number[]> {
  const outputs = await Promise.all(
    ["comm=", "ucomm="].map(async (field) => {
      const { stdout } = await execute("ps", ["-axo", "pid=", "-o", field], {
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      return bundleProcessIds(stdout, bundle)
    })
  )
  return [...new Set(outputs.flat())]
}

export function desktopLaunchEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "MAKO_DATA_ROOT",
    "MAKO_PROFILE",
    "MAKO_HOST_ONLY",
    "MAKO_STANDALONE",
    "MAKO_WEB_SOCKET",
    "MAKO_WEB_ONLY",
    "MAKO_CLIENT_ID",
    "MAKO_PROD",
    "MAKO_KIRI_BINARY",
    "VITE_DEV_SERVER_URL",
  ])
    delete clean[key]
  return clean
}

export type LocalInstallReceipt =
  | { ok: true; backup: string | null; message?: string }
  | { ok: false; message: string }

interface InstallCompletion {
  replace(): Promise<string | null>
  save(receipt: LocalInstallReceipt): Promise<void>
  launch(): Promise<void>
}

export async function completeLocalInstall(
  input: InstallCompletion
): Promise<void> {
  let backup: string | null
  try {
    backup = await input.replace()
  } catch (error) {
    await input.save({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Installation failed. The previous application was retained.",
    })
    await input.launch().catch(() => {})
    throw error
  }
  await input.save({ ok: true, backup })
  try {
    await input.launch()
  } catch (error) {
    await input.save({
      ok: true,
      backup,
      message:
        "The update was installed, but Mako could not reopen. Open Mako from Applications.",
    })
    throw error
  }
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
      if (!hostAlive && !(await runningBundleProcesses(target)).length) break
      if (Date.now() >= deadline)
        throw new Error("Mako processes are still running")
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } catch (error) {
    if (authorized) {
      await writeFile(
        receipt,
        JSON.stringify({
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "The update could not be installed. The previous app was retained.",
        }),
        { mode: 0o600 }
      )
      await execute("open", [target], {
        timeout: 10_000,
        env: desktopLaunchEnvironment(process.env),
      }).catch(() => {})
    }
    process.exitCode = 1
    if (process.connected) process.disconnect()
    return
  }
  await completeLocalInstall({
    replace: () =>
      replacePreparedApplication({
        staging,
        target,
        verify,
        ready: async () => {
          if ((await runningBundleProcesses(target)).length)
            throw new Error(
              "Mako started during verification. Nothing was replaced."
            )
        },
      }),
    save: async (result) => {
      await writeFile(receipt, JSON.stringify(result), { mode: 0o600 })
    },
    launch: async () => {
      await execute("open", [target], {
        timeout: 10_000,
        env: desktopLaunchEnvironment(process.env),
      })
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runInstaller().catch(() => {
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
