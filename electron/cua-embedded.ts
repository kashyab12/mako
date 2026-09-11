import { spawn, type ChildProcess } from "node:child_process"
import { access, chmod, mkdir, readdir, unlink } from "node:fs/promises"
import { createConnection } from "node:net"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"

let child: ChildProcess | null = null
let socketPath: string | null = null
let starting: Promise<string | null> | null = null
let stderr = ""

async function executable(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const candidates = isAbsolute(command)
    ? [command]
    : [
        ...(env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command)),
        join(homedir(), ".local", "bin", command),
        "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    const finish = (available: boolean) => {
      socket.destroy()
      resolve(available)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

/**
 * Each host names its driver socket after its own pid; a host that died
 * without its shutdown path leaves that file behind. Dozens accumulate. A
 * socket whose owner no longer runs is unlinked before this host adds its own.
 */
async function sweepStaleSockets(stateDir: string): Promise<void> {
  const names = await readdir(stateDir).catch((): string[] => [])
  for (const name of names) {
    const match = /^embedded-(\d+)\.sock$/.exec(name)
    if (!match) continue
    const owner = Number(match[1])
    if (owner === process.pid) continue
    try {
      process.kill(owner, 0)
      continue
    } catch {
      await unlink(join(stateDir, name)).catch(() => undefined)
    }
  }
}

async function waitForSocket(path: string, process: ChildProcess) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(
        stderr.trim() || `Embedded CUA Driver exited with ${process.exitCode}`
      )
    }
    if (await probe(path)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Embedded CUA Driver did not open its private socket")
}

export function ensureCuaEmbedded(
  stateDir: string,
  hostBundleId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null)
  if (child && child.exitCode === null && socketPath) {
    return Promise.resolve(socketPath)
  }
  starting ??= start(stateDir, hostBundleId, env).finally(() => {
    starting = null
  })
  return starting
}

async function start(
  stateDir: string,
  hostBundleId: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const command = await executable("cua-driver", env)
  if (!command) return null
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  await sweepStaleSockets(stateDir)
  const nextSocket = join(stateDir, `embedded-${process.pid}.sock`)
  await unlink(nextSocket).catch(() => undefined)
  stderr = ""
  const processChild = spawn(
    command,
    ["serve", "--embedded", "--socket", nextSocket],
    {
      env: {
        ...env,
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId,
        CUA_DRIVER_PERMISSION_MODE: "standard",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    }
  )
  child = processChild
  socketPath = nextSocket
  processChild.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000)
  })
  processChild.once("exit", () => {
    if (child !== processChild) return
    child = null
    socketPath = null
    void unlink(nextSocket).catch(() => undefined)
  })
  try {
    await waitForSocket(nextSocket, processChild)
    return nextSocket
  } catch (error) {
    processChild.kill("SIGTERM")
    child = null
    socketPath = null
    await unlink(nextSocket).catch(() => undefined)
    throw error
  }
}

export function cuaEmbeddedSocket(): string | null {
  return child && socketPath ? socketPath : null
}

export function stopCuaEmbedded(): void {
  const running = child
  const currentSocket = socketPath
  child = null
  socketPath = null
  running?.kill("SIGTERM")
  if (currentSocket) void unlink(currentSocket).catch(() => undefined)
}
