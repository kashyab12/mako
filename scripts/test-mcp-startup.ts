import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, delimiter } from "node:path"
import { mock } from "node:test"
import { providerHost } from "../electron/providers/index.js"
import { discoverMcpRegistry } from "../electron/mcp-registry.js"
import type { ProviderMcpSource } from "../electron/providers/mcp-source.js"

const root = await mkdtemp(join(tmpdir(), "mako-mcp-startup-"))
const providerStarted = join(root, "provider-started")
const doctorStarted = join(root, "doctor-started")
for (const [name, own, peer, output] of [
  [
    "fixture-provider",
    providerStarted,
    doctorStarted,
    JSON.stringify({
      mcpServers: { fixture: { url: "http://127.0.0.1:9/mcp" } },
    }),
  ],
  ["macos-harness", doctorStarted, providerStarted, "doctor passed"],
]) {
  await writeFile(
    join(root, name),
    `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(own)}, 'started');
const deadline = Date.now() + 3000;
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(peer)})) { clearInterval(timer); writeFileSync(${JSON.stringify(own)}, 'finished'); console.log(${JSON.stringify(output)}); }
  else if (Date.now() > deadline) { clearInterval(timer); process.exitCode = 17; }
}, 5);
`,
    { mode: 0o700 }
  )
}
const source: ProviderMcpSource = {
  provider: "startup-mcp-fixture",
  command: () => join(root, "fixture-provider"),
  userFiles: () => [],
  workspaceFiles: () => [],
  readsCli: true,
  write: { kind: "none" },
}
providerHost.mcpSources.register(source)
const listing = mock.method(providerHost.mcpSources, "list", () => [source])
const previousPath = process.env.PATH
process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`
try {
  const snapshot = await discoverMcpRegistry(root, root)
  assert.ok(
    snapshot.servers.some((server) => server.name === "fixture"),
    "Provider discovery must run alongside the managed doctor, not before it"
  )
  assert.equal(
    await readFile(doctorStarted, "utf8"),
    "finished",
    "Managed diagnostics must still complete"
  )
  assert.ok(
    snapshot.servers.some((server) => server.name === "mako-local-tools")
  )
  console.log(
    "MCP startup: provider discovery and managed diagnostics run concurrently without skipping either result"
  )
} finally {
  listing.mock.restore()
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  await rm(root, { recursive: true, force: true })
}
