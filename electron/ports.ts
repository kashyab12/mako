import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ListeningPort } from "./shared.js"

const run = promisify(execFile)

/**
 * What is listening on this machine.
 *
 * The remote version of this feature is SSH tunnels to a container, and there
 * is no container. The local version is the part that actually gets used every
 * day anyway: an agent starts a backend on one port and a front end on
 * another, and you need to know which is which and be able to look at either.
 * Codespaces' Ports tab minus the forwarding, which is the useful ninety
 * percent.
 *
 * `lsof` rather than reading /proc or a native module: it is on every macOS
 * and Linux box, it reports the owning process, and its field mode is stable
 * output designed for exactly this.
 */

/** Ports every machine has open that nobody wants offered as a preview. */
const NOISE = new Set([22, 88, 445, 631, 5000, 7000, 49152])

/** Processes that listen but never serve anything a person wants to open. */
const NOISE_COMMANDS = /^(ControlCe|rapportd|sharingd|remoted|launchd|mDNSResponder|cupsd|sshd)/i

/**
 * Commands that usually *are* the thing you want to look at.
 *
 * Used only for ordering — nothing is hidden for failing to match, because the
 * whole point is finding the server you did not expect.
 *
 * The trailing `\b` matters: without it `go` matches "Google Chrome", and the
 * browser's debug port sorts above your actual dev server.
 */
const LIKELY =
  /^(node|bun|deno|python3?|ruby|php|java|go|cargo|rustc|next|vite|dotnet|caddy|nginx)\b/i

interface Row {
  pid: number
  command: string
  addresses: string[]
}

export async function listPorts(): Promise<ListeningPort[]> {
  let stdout = ""
  try {
    // -P numeric ports, -n numeric hosts (both skip slow lookups), field mode
    // for p(id), c(ommand) and n(ame).
    const result = await run("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch (error) {
    // lsof exits non-zero when it finds nothing, and may not exist at all.
    stdout = (error as { stdout?: string }).stdout ?? ""
  }

  const rows: Row[] = []
  let current: Row | null = null
  for (const line of stdout.split("\n")) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === "p") {
      current = { pid: Number(value), command: "", addresses: [] }
      rows.push(current)
    } else if (tag === "c" && current) {
      current.command = value
    } else if (tag === "n" && current) {
      current.addresses.push(value)
    }
  }

  // One entry per port, not per file descriptor: a server bound to both IPv4
  // and IPv6 is one server, and listing it twice is noise that looks like a
  // bug.
  const byPort = new Map<number, ListeningPort>()
  for (const row of rows) {
    if (NOISE_COMMANDS.test(row.command)) continue
    for (const address of row.addresses) {
      const port = Number(address.split(":").pop())
      if (!Number.isInteger(port) || port <= 0 || NOISE.has(port)) continue
      const host = address.slice(0, address.lastIndexOf(":"))
      // A server bound only to a loopback address cannot be reached from
      // anywhere else, which is worth saying rather than implying.
      const loopback = host === "127.0.0.1" || host === "[::1]" || host === "localhost"
      const existing = byPort.get(port)
      if (existing) {
        existing.loopbackOnly = existing.loopbackOnly && loopback
        continue
      }
      byPort.set(port, {
        port,
        pid: row.pid,
        command: row.command,
        url: `http://localhost:${port}`,
        loopbackOnly: loopback,
        likely: LIKELY.test(row.command),
      })
    }
  }

  return [...byPort.values()].sort((a, b) => {
    // Things that look like a dev server first, then by port so the order is
    // stable between refreshes.
    if (a.likely !== b.likely) return a.likely ? -1 : 1
    return a.port - b.port
  })
}
