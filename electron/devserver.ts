import { spawn, type ChildProcess } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { DevServerState, HostEvent } from "./shared.js"

/**
 * The project's dev server, run from here.
 *
 * The point is not to save you a terminal. It is that the thing the agent is
 * building and the conversation about it are the same activity, and putting
 * them a window-switch apart is what makes people stop looking at the result.
 *
 * Two rules:
 *
 *   * **Never start on its own.** Running an arbitrary script from a folder
 *     you just opened is not a thing an editor should do quietly. Opening the
 *     pane offers; the button starts.
 *   * **Always stop when the app does.** A dev server that outlives the window
 *     holds its port and is invisible — the worst combination.
 */

interface PackageJson {
  scripts?: Record<string, string>
}

/** Scripts worth offering, in the order anyone would try them. */
const CANDIDATES = ["dev", "start", "serve", "develop"]

/** Kept for the log pane; a dev server can print a great deal. */
const MAX_LINES = 500

let child: ChildProcess | null = null
let state: DevServerState = { status: "idle", lines: [] }
let emit: (event: HostEvent) => void = () => {}

function publish(patch: Partial<DevServerState>) {
  state = { ...state, ...patch }
  emit({ type: "devserver", devserver: state })
}

export function devServerState(): DevServerState {
  return state
}

export function bindDevServer(send: (event: HostEvent) => void) {
  emit = send
}

/** Which scripts this project actually has, so the UI offers real choices. */
export async function devScripts(cwd: string): Promise<string[]> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8")
    const packageJson: PackageJson = JSON.parse(raw)
    const scripts = packageJson.scripts ?? {}
    const names = Object.keys(scripts)
    // Known names first, then anything else that smells like a server.
    const known = CANDIDATES.filter((name) => names.includes(name))
    const rest = names.filter((name) => !known.includes(name) && /dev|serve|start|watch/.test(name))
    return [...known, ...rest]
  } catch {
    return []
  }
}

/**
 * The address a dev server just announced.
 *
 * Every tool prints this differently and none of them print it as JSON, so
 * this reads the one thing they all agree on: a localhost URL somewhere in the
 * output. `127.0.0.1` is rewritten to `localhost` only when the tool used it
 * itself — some setups bind one and not the other, and guessing costs a blank
 * pane that looks like the server failed.
 */
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s"'`]*/i

function sniffUrl(line: string): string | undefined {
  const found = URL_PATTERN.exec(stripAnsi(line))?.[0]
  if (!found) return undefined
  // 0.0.0.0 means "every interface" to the server and nothing to a browser.
  return found.replace("0.0.0.0", "localhost")
}

/** Terminal colour codes are noise in a log pane and break URL matching. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, "")
}

function append(chunk: string) {
  const lines = [...state.lines]
  for (const line of chunk.split("\n")) {
    const clean = stripAnsi(line).trimEnd()
    if (!clean) continue
    lines.push(clean)
    if (!state.url) {
      const url = sniffUrl(clean)
      // The first address wins: tools that print both a local and a network
      // address always print local first, and it is the one that works.
      if (url) publish({ url, status: "running" })
    }
  }
  publish({ lines: lines.slice(-MAX_LINES) })
}

export async function startDevServer(cwd: string, script: string): Promise<DevServerState> {
  await stopDevServer()
  publish({ status: "starting", script, url: undefined, lines: [], exitCode: undefined })

  child = spawn("npm", ["run", script], {
    cwd,
    // Not a shell: the script name comes from package.json, but treating it as
    // shell input would make an unusual script name an injection.
    shell: false,
    // Its own process group, so stopping it stops the server `npm run` spawned
    // underneath it rather than only the npm wrapper — which is how a dev
    // server ends up orphaned holding its port.
    detached: true,
    env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout?.on("data", (data: Buffer) => append(data.toString()))
  child.stderr?.on("data", (data: Buffer) => append(data.toString()))

  child.on("error", (error) => {
    publish({ status: "failed", lines: [...state.lines, error.message] })
    child = null
  })

  child.on("exit", (code) => {
    child = null
    // A server that exits on its own has failed, however it exited: the whole
    // point of it is to keep running.
    publish({ status: state.status === "stopping" ? "idle" : "failed", exitCode: code ?? undefined })
  })

  return state
}

export async function stopDevServer(): Promise<DevServerState> {
  const running = child
  if (!running) {
    publish({ status: "idle", url: undefined })
    return state
  }
  publish({ status: "stopping" })
  child = null

  return new Promise((resolve) => {
    const done = () => {
      publish({ status: "idle", url: undefined })
      resolve(state)
    }
    running.once("exit", done)
    // `npm run` spawns the real server as a child, so signalling the process
    // group is what actually stops it. Negative pid means the group.
    try {
      if (running.pid) process.kill(-running.pid, "SIGTERM")
      else running.kill("SIGTERM")
    } catch {
      running.kill("SIGTERM")
    }
    // If it will not go quietly, insist — and never leave the promise open.
    setTimeout(() => {
      try {
        if (running.pid) process.kill(-running.pid, "SIGKILL")
      } catch {
        // Already gone.
      }
      done()
    }, 4000).unref?.()
  })
}

/** Point the pane at something already running, without starting anything. */
export function attachDevServer(url: string): DevServerState {
  publish({ status: "running", url, script: undefined, lines: [] })
  return state
}
