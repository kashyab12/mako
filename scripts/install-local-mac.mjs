import assert from "node:assert/strict"
import { cp, lstat, mkdtemp, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  resolveLocalIdentity,
  verifyLocalSignature,
} from "./mac-local-signing.mjs"

const target = "/Applications/Mako.app"

export async function localRuntime() {
  const { runtimeInfo } = await import("../dist-electron/runtime-connection.js")
  const { runtimeDataRoot, runtimeLocation } =
    await import("../dist-electron/runtime-service.js")
  const dataRoot = runtimeDataRoot(
    join(homedir(), "Library/Application Support"),
    {}
  )
  const { socket } = runtimeLocation(dataRoot)
  return { socket, host: await runtimeInfo(socket) }
}

export async function runningProcesses() {
  const { runningBundleProcesses } =
    await import("../dist-electron/local-update-installer.js")
  const pids = await runningBundleProcesses(target)
  const { host } = await localRuntime()
  if (host && !pids.includes(host.pid)) pids.push(host.pid)
  return pids
}

async function main() {
  const args = process.argv.slice(2)
  assert.equal(process.platform, "darwin", "Local installation is macOS-only")
  assert.ok(
    args.length >= 1 &&
      args.length <= 2 &&
      (!args[1] || args[1] === "--install"),
    "Use <Mako.app> [--install]. Without --install this only checks readiness."
  )
  const source = await realpath(resolve(args[0]))
  assert.notEqual(
    source,
    target,
    "The candidate must be outside the installed app"
  )
  const identity = await resolveLocalIdentity(undefined, source)
  const current = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  assert.ok(
    !current || (current.isDirectory() && !current.isSymbolicLink()),
    "The installed app must be a real directory, not a symlink"
  )
  const running = await runningProcesses()
  console.log(
    JSON.stringify(
      {
        source,
        target,
        identity,
        runningPids: running,
        ready: running.length === 0,
      },
      null,
      2
    )
  )
  if (args.includes("--install")) {
    assert.equal(
      running.length,
      0,
      "Mako or its shared host is still running. Finish active work and shut down the host and its MCP clients before installing. Nothing was stopped or replaced."
    )
    const staging = await mkdtemp(join(dirname(target), ".mako-local-install-"))
    const candidate = join(staging, "Mako.app")
    await cp(source, candidate, {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
    await verifyLocalSignature(candidate, identity)
    assert.equal(
      (await runningProcesses()).length,
      0,
      `Mako started during preparation. The installed app was not changed; the candidate remains at ${candidate}`
    )
    const { replacePreparedApplication } =
      await import("../dist-electron/local-update-installer.js")
    const backup = await replacePreparedApplication({
      staging,
      target,
      verify: (app) => verifyLocalSignature(app, identity),
      ready: async () =>
        assert.equal(
          (await runningProcesses()).length,
          0,
          "Mako started during verification. Nothing was replaced."
        ),
    })
    console.log(
      `Installed ${target}. Previous app retained at ${backup ?? "none"}. Open the installed app before starting a development host.`
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
