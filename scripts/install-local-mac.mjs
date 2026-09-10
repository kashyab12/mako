import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, lstat, mkdtemp, realpath, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { runtimeInfo } from "../dist-electron/runtime-connection.js"
import { runtimeDataRoot, runtimeLocation } from "../dist-electron/runtime-service.js"
import { resolveLocalIdentity, verifyLocalSignature } from "./mac-local-signing.mjs"

const run = promisify(execFile)
const args = process.argv.slice(2)
assert.equal(process.platform, "darwin", "Local installation is macOS-only")
assert.ok(args.length >= 1 && args.length <= 2 && (!args[1] || args[1] === "--install"), "Use <Mako.app> [--install]. Without --install this only checks readiness.")
const source = await realpath(resolve(args[0]))
const target = "/Applications/Mako.app"
assert.notEqual(source, target, "The candidate must be outside the installed app")
const identity = await resolveLocalIdentity(undefined, source)
const current = await lstat(target).catch((error) => {
  if (error.code === "ENOENT") return null
  throw error
})
assert.ok(!current || (current.isDirectory() && !current.isSymbolicLink()), "The installed app must be a real directory, not a symlink")

async function runningProcesses() {
  const { stdout } = await run("ps", ["-axo", "pid=,comm="], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
  const pids = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match?.[2].startsWith(`${target}/Contents/`) ? [Number(match[1])] : []
  })
  const dataRoot = runtimeDataRoot(join(homedir(), "Library/Application Support"), {})
  const host = await runtimeInfo(runtimeLocation(dataRoot).socket)
  if (host && !pids.includes(host.pid)) pids.push(host.pid)
  return pids
}

const running = await runningProcesses()
console.log(JSON.stringify({ source, target, identity, runningPids: running, ready: running.length === 0 }, null, 2))
if (args.includes("--install")) {
  assert.equal(running.length, 0, "Mako or its shared host is still running. Finish active work and shut down the host and its MCP clients before installing. Nothing was stopped or replaced.")
  const staging = await mkdtemp(join(dirname(target), ".mako-local-install-"))
  const candidate = join(staging, "Mako.app")
  await cp(source, candidate, { recursive: true, errorOnExist: true, force: false })
  await verifyLocalSignature(candidate, identity)
  assert.equal((await runningProcesses()).length, 0, `Mako started during preparation. The installed app was not changed; the candidate remains at ${candidate}`)
  const backup = join(staging, "Previous Mako.app")
  if (current) await rename(target, backup)
  try {
    await rename(candidate, target)
  } catch (error) {
    if (current) await rename(backup, target)
    throw error
  }
  await verifyLocalSignature(target, identity)
  console.log(`Installed ${target}. Previous app retained at ${current ? backup : "none"}. Open the installed app before starting a development host.`)
}
