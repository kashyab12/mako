import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { providerHost } from "../electron/providers/index"
import { acpReadable, acpWritable } from "../electron/acp-stream"

const requested = process.argv.slice(2)
const root = await mkdtemp(join(tmpdir(), "mako-acp-auth-probe-"))
try {
  for (const source of providerHost.acpSources.list().filter((source) => !requested.length || requested.includes(source.provider))) {
    const launch = await source.launch({ appPath: process.cwd(), execPath: process.execPath })
    if (!launch) { console.log(JSON.stringify({ provider: source.provider, available: false })); continue }
    const env = { ...process.env }
    launch.configureEnvironment(env)
    const child = spawn(launch.command, launch.args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] })
    const exited = once(child, "exit")
    child.stderr.resume()
    const connection = new ClientSideConnection(() => ({
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async () => {},
    }), ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const initialized = await Promise.race([
        connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "mako", title: "Mako auth capability probe", version: "0.0.1" }, clientCapabilities: {} }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Initialize timed out")), 15000) }),
      ])
      assert.ok(initialized.protocolVersion)
      console.log(JSON.stringify({ provider: source.provider, executable: launch.command, agent: initialized.agentInfo, authMethods: initialized.authMethods?.map((method) => ({ id: method.id, name: method.name, description: method.description, type: method.type })) }, null, 2))
    } finally {
      clearTimeout(timer)
      child.kill("SIGTERM")
      const force = setTimeout(() => child.kill("SIGKILL"), 3000)
      await exited
      clearTimeout(force)
    }
  }
} finally { await rm(root, { recursive: true, force: true }) }
