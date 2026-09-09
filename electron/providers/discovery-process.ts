import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { basename } from "node:path"
import { environmentForExecutable, resolveExecutable } from "../executable.js"

interface DiscoveryOptions {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
}

interface DiscoveryProcess {
  child: ChildProcessWithoutNullStreams
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  phase(name: string): void
}

const pending: Array<() => void> = []
let active = 0

export async function withDiscoveryProcess<T>(
  options: DiscoveryOptions,
  run: (process: DiscoveryProcess) => Promise<T>
): Promise<T> {
  const executable = resolveExecutable(options.command, options.env)
  const label = basename(options.command)
  if (!executable) throw new Error(`${label} is not installed`)
  if (active < 4) active++
  else {
    if (pending.length >= 64)
      throw new Error("Provider discovery queue is full")
    await new Promise<void>((resolve) => pending.push(resolve))
  }
  let release: (() => Promise<void>) | undefined
  try {
    const grouped = process.platform !== "win32"
    const child = spawn(executable, options.args, {
      cwd: options.cwd,
      env: environmentForExecutable(executable, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: grouped,
      windowsHide: true,
    })
    return await new Promise<T>((resolve, reject) => {
      let phase = "startup"
      let bytes = 0
      const exited = new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      const fail = (error: Error) => reject(error)
      child.on("error", fail)
      child.stdin.on("error", fail)
      child.stdout.on("error", fail)
      child.stderr.on("error", fail)
      child.stderr.resume()
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 8_000_000) {
          fail(new Error(`${label} discovery response exceeded 8 MB`))
          child.stdout.destroy()
        }
      })
      const timeout = options.timeoutMs ?? 30_000
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `${label} discovery timed out during ${phase} after ${timeout} ms`
            )
          ),
        timeout
      )
      const terminate = (signal: NodeJS.Signals) => {
        if (grouped && child.pid) {
          try {
            process.kill(-child.pid, signal)
            return
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              (error.code !== "ESRCH" && error.code !== "EPERM")
            )
              throw error
          }
        }
        child.kill(signal)
      }
      release = async () => {
        clearTimeout(timer)
        try {
          await new Promise<void>((resolve, reject) => {
            if (child.exitCode === null && child.signalCode === null)
              terminate("SIGTERM")
            const force = setTimeout(() => {
              try {
                terminate("SIGKILL")
              } catch (error) {
                reject(error)
              }
            }, 1_000)
            void exited.then(() => {
              clearTimeout(force)
              resolve()
            })
          })
        } finally {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
        }
      }
      Promise.resolve()
        .then(() =>
          run({
            child,
            exited,
            phase: (name) => {
              phase = name
            },
          })
        )
        .then(resolve, reject)
    })
  } finally {
    try {
      await release?.()
    } finally {
      const next = pending.shift()
      if (next) next()
      else active--
    }
  }
}
