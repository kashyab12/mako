import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  acpMcpServers,
  atomicMergeMcpJson,
  codexMcpConfig,
  managedMcpDefinitions,
  mergeMcpDefinitions,
  parseProviderJson,
  previewMcpSync,
} from "../electron/mcp.js"
import { LOCAL_TOOL_INPUTS } from "../electron/local-tools-main.js"
import { atomicJsonMcpMerge, mergeJsonMcpConfig } from "../electron/mcp-sync.js"
import type { McpDiscoveredDefinition } from "../electron/mcp-registry.js"
import type { JsonValue } from "../electron/codex-app-protocol.js"
import type { McpProvider, McpRegistrySnapshot } from "../electron/shared.js"

function discovered(
  provider: McpProvider,
  name: string,
  config: JsonValue
): McpDiscoveredDefinition {
  const [definition] = parseProviderJson(
    provider,
    JSON.stringify({ mcpServers: { [name]: config } })
  )
  assert.ok(definition)
  return {
    definition,
    origin: {
      provider,
      account: "default",
      scope: "user",
      provenance: `${provider} test config`,
    },
  }
}

function testProtocolVersion(): void {
  assert.equal(LATEST_PROTOCOL_VERSION, "2025-11-25")
}

function testProviderFixtures(): void {
  const json = JSON.stringify({
    mcpServers: { shared: { command: "/bin/server", args: ["serve"] } },
  })
  for (const provider of ["claude", "cursor", "devin"] as const) {
    const [definition] = parseProviderJson(provider, json)
    assert.equal(definition?.name, "shared")
    assert.equal(definition?.transport, "stdio")
  }
  const [codex] = parseProviderJson(
    "codex",
    JSON.stringify([
      {
        name: "remote",
        transport: { type: "streamable_http", url: "https://example.test/mcp" },
      },
    ])
  )
  const [grok] = parseProviderJson(
    "grok",
    JSON.stringify([
      {
        name: "events",
        transport: { type: "sse", url: "https://example.test/events" },
      },
    ])
  )
  assert.equal(codex?.transport, "http")
  assert.equal(grok?.transport, "sse")
}

function testAxiomPreview(): void {
  const definition = parseProviderJson(
    "codex",
    JSON.stringify([
      {
        name: "axiom",
        enabled: true,
        auth_status: "o_auth",
        transport: {
          type: "streamable_http",
          url: "https://mcp.axiom.co/mcp",
        },
      },
    ])
  )[0]
  assert.deepEqual(definition, {
    name: "axiom",
    transport: "http",
    url: "https://mcp.axiom.co/mcp",
    envNames: [],
    headerNames: [],
    portable: true,
  })
  const claude = z
    .object({
      mcpServers: z.record(
        z.string(),
        z.object({ type: z.string(), url: z.string() })
      ),
    })
    .parse(JSON.parse(mergeJsonMcpConfig("", definition, "claude")))
  assert.deepEqual(claude.mcpServers.axiom, {
    type: "http",
    url: "https://mcp.axiom.co/mcp",
  })
}

async function testAxiomSyncPreview(): Promise<void> {
  const servers = mergeMcpDefinitions([
    {
      ...discovered("codex", "axiom", {
        transport: { type: "streamable_http", url: "https://mcp.axiom.co/mcp" },
      }),
      origin: {
        provider: "codex",
        account: "work",
        scope: "effective",
        provenance: "codex fixture",
      },
    },
  ])
  const snapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    servers,
    providers: [
      {
        id: "claude",
        label: "Claude Code",
        account: "default",
        available: true,
        source: "fixture",
      },
    ],
  }
  const preview = await previewMcpSync(snapshot, servers[0]!.id, {
    provider: "claude",
    account: "default",
    scope: "user",
  })
  assert.equal(preview.action, "add")
  const isolated = await previewMcpSync(snapshot, servers[0]!.id, {
    provider: "claude",
    account: "another-account",
    scope: "user",
  })
  assert.equal(isolated.action, "blocked")
  assert.match(isolated.blockReason ?? "", /selected account/)
}

function testRedaction(): void {
  const secret = "sk-test-never-cross-the-bridge"
  const records = mergeMcpDefinitions([
    discovered("claude", "private", {
      command: process.execPath,
      args: ["server.js", `--token=${secret}`, "--api-key", secret],
      env: { API_KEY: secret, MODE: "test" },
    }),
    discovered("cursor", "remote", {
      url: `https://user:pass@example.test/mcp?api_key=${secret}`,
    }),
  ])
  const serialized = JSON.stringify(records)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes("pass"), false)
  assert.equal(
    records.every((server) => !server.portable),
    true
  )
  assert.deepEqual(
    records.find((server) => server.name === "private")?.envNames,
    ["API_KEY", "MODE"]
  )
  const [authenticated] = parseProviderJson(
    "codex",
    JSON.stringify([
      {
        name: "authenticated",
        transport: {
          type: "streamable_http",
          url: "https://secure.example.test/mcp",
          bearer_token_env_var: "MCP_TOKEN",
          env_http_headers: { "X-Workspace": "WORKSPACE_ID" },
        },
      },
    ])
  )
  assert.equal(authenticated?.portable, false)
  assert.deepEqual(authenticated?.envNames, ["MCP_TOKEN", "WORKSPACE_ID"])
  assert.deepEqual(authenticated?.headerNames, ["X-Workspace"])
}

function testDedupeAndConflicts(): void {
  const same = { command: process.execPath, args: ["same-server.js"] }
  const records = mergeMcpDefinitions([
    discovered("claude", "shared", same),
    discovered("cursor", "shared", same),
    discovered("codex", "drift", {
      command: process.execPath,
      args: ["one.js"],
    }),
    discovered("grok", "drift", {
      command: process.execPath,
      args: ["two.js"],
    }),
  ])
  const shared = records.find((server) => server.name === "shared")
  assert.equal(shared?.origins.length, 2)
  assert.equal(records.filter((server) => server.name === "shared").length, 1)
  assert.equal(
    records
      .filter((server) => server.name === "drift")
      .every((server) => server.conflict === "drift"),
    true
  )
}

async function testAtomicConcurrency(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mako-mcp-"))
  const file = join(directory, "mcp.json")
  try {
    await Promise.all([
      atomicMergeMcpJson(file, { alpha: { command: "alpha" } }),
      atomicMergeMcpJson(file, { beta: { command: "beta" } }),
    ])
    const value = z
      .object({ mcpServers: z.record(z.string(), z.object({}).passthrough()) })
      .parse(JSON.parse(await readFile(file, "utf8")))
    assert.deepEqual(Object.keys(value.mcpServers).sort(), ["alpha", "beta"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function testSerializedGuardedMerge(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mako-mcp-serialized-"))
  const file = join(directory, "mcp.json")
  const original = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`
  const expected = createHash("sha256").update(original).digest("hex")
  const definition = (name: string) => ({
    name,
    transport: "stdio" as const,
    command: `/bin/${name}`,
    args: [],
    envNames: [],
    headerNames: [],
    portable: true,
  })
  try {
    await writeFile(file, original)
    const settled = await Promise.allSettled([
      atomicJsonMcpMerge(file, expected, definition("alpha")),
      atomicJsonMcpMerge(file, expected, definition("beta")),
    ])
    assert.deepEqual(
      settled.map((result) => result.status).sort(),
      ["fulfilled", "rejected"]
    )
    const value = z
      .object({ mcpServers: z.record(z.string(), z.json()) })
      .parse(JSON.parse(await readFile(file, "utf8")))
    assert.equal(Object.keys(value.mcpServers).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function testGuardedAtomicMerge(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mako-mcp-guard-"))
  const file = join(directory, "mcp.json")
  const original = `${JSON.stringify({ mcpServers: { alpha: { command: "alpha" } } }, null, 2)}\n`
  const definition = {
    name: "beta",
    transport: "stdio" as const,
    command: "/bin/beta",
    args: [],
    envNames: [],
    headerNames: [],
    portable: true,
  }
  try {
    await writeFile(file, original, { mode: 0o644 })
    const expected = createHash("sha256").update(original).digest("hex")
    await atomicJsonMcpMerge(file, expected, definition)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const current = await readFile(file, "utf8")
    const stale = createHash("sha256").update(current).digest("hex")
    await writeFile(
      file,
      mergeJsonMcpConfig(current, { ...definition, name: "gamma" })
    )
    await assert.rejects(
      atomicJsonMcpMerge(file, stale, { ...definition, name: "delta" }),
      /changed after preview/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function testAcpProjection(): void {
  const servers = mergeMcpDefinitions([
    discovered("claude", "local", {
      command: process.execPath,
      args: ["server.js"],
    }),
    discovered("cursor", "docs", {
      type: "http",
      url: "https://docs.example.test/mcp",
    }),
  ])
  const snapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    servers,
    providers: [],
  }
  assert.deepEqual(acpMcpServers(snapshot, "devin", ["stdio", "http"]), [
    {
      name: "docs",
      type: "http",
      url: "https://docs.example.test/mcp",
      headers: [],
    },
    {
      name: "local",
      command: process.execPath,
      args: ["server.js"],
      env: [],
    },
  ])
  assert.deepEqual(acpMcpServers(snapshot, "claude", ["stdio", "http"]), [
    {
      name: "docs",
      type: "http",
      url: "https://docs.example.test/mcp",
      headers: [],
    },
  ])
}

async function testManagedDefinitions(): Promise<void> {
  const definitions = await managedMcpDefinitions("/app", "/electron", {
    PATH: "",
  })
  const browser = definitions.find(
    (entry) => entry.definition.name === "browser-use"
  )
  assert.deepEqual(browser?.definition.args, [
    "--from",
    "browser-use[cli]",
    "browser-use",
    "--cli-mcp",
  ])
  assert.equal(
    definitions.some((entry) => entry.definition.name === "mako-local-tools"),
    true
  )
  assert.equal(
    definitions.some((entry) => entry.definition.name === "cua-driver"),
    true
  )
  const localTools = definitions.find(
    (entry) => entry.definition.name === "mako-local-tools"
  )
  assert.ok(localTools)
  const managedSnapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    servers: mergeMcpDefinitions(definitions),
    providers: [],
  }
  assert.deepEqual(
    acpMcpServers(managedSnapshot, "claude", ["stdio", "http"]),
    []
  )
  const cursor = z
    .object({
      mcpServers: z.record(
        z.string(),
        z.object({ env: z.record(z.string(), z.string()) })
      ),
    })
    .parse(JSON.parse(mergeJsonMcpConfig("", localTools.definition, "cursor")))
  assert.deepEqual(cursor.mcpServers["mako-local-tools"]?.env, {
    ELECTRON_RUN_AS_NODE: "1",
  })
}

async function testMakoRuntimeProjection(): Promise<void> {
  const managed = (
    name: "browser-use" | "mako-local-tools" | "cua-driver",
    command: string,
    args: string[]
  ): McpDiscoveredDefinition => ({
    definition: {
      name,
      transport: "stdio",
      command,
      args,
      envNames: name === "mako-local-tools" ? ["ELECTRON_RUN_AS_NODE"] : [],
      headerNames: [],
      portable: true,
    },
    origin: {
      provider: "mako",
      account: "local",
      scope: "managed",
      provenance: "Mako managed (test)",
    },
  })
  const snapshot: McpRegistrySnapshot = {
    cwd: tmpdir(),
    generatedAt: 1,
    providers: [],
    servers: mergeMcpDefinitions([
      managed("browser-use", "uvx", ["browser-use", "--cli-mcp"]),
      managed("mako-local-tools", process.execPath, ["local-tools.js"]),
      managed("cua-driver", "cua-driver", ["mcp"]),
    ]).map((server) => ({
      ...server,
      managed: true,
      availability: "available" as const,
    })),
  }
  assert.deepEqual(
    acpMcpServers(snapshot, "claude", ["stdio"]).map((server) => server.name),
    ["browser-use", "mako-local-tools"]
  )
  const codex = codexMcpConfig(snapshot)
  const servers = z
    .object({ mcp_servers: z.record(z.string(), z.json()) })
    .parse(codex).mcp_servers
  assert.deepEqual(Object.keys(servers).sort(), [
    "browser-use",
    "mako-local-tools",
  ])
  const browserServer = snapshot.servers.find(
    (server) => server.name === "browser-use"
  )
  assert.ok(browserServer)
  const preview = await previewMcpSync(
    snapshot,
    browserServer.id,
    {
      provider: "claude",
      account: "default",
      scope: "user",
    }
  )
  assert.equal(preview.action, "blocked")
  assert.match(preview.blockReason ?? "", /sessions launched by Mako/)

  const nativeSnapshot: McpRegistrySnapshot = {
    ...snapshot,
    servers: mergeMcpDefinitions([
      managed("browser-use", "uvx", ["browser-use", "--cli-mcp"]),
      managed("mako-local-tools", process.execPath, ["local-tools.js"]),
      discovered("claude", "node_repl", { command: process.execPath }),
    ]).map((server) => ({
      ...server,
      managed: server.origins.some((origin) => origin.provider === "mako"),
      availability: "available" as const,
    })),
  }
  assert.deepEqual(acpMcpServers(nativeSnapshot, "claude", ["stdio"]), [])
}

function testLocalSchemas(): void {
  assert.equal(LOCAL_TOOL_INPUTS.apps.safeParse({}).success, true)
  assert.equal(LOCAL_TOOL_INPUTS.apps.safeParse({ extra: true }).success, false)
  assert.equal(
    LOCAL_TOOL_INPUTS.click.safeParse({ app: "Finder", x: 10, y: 20 }).success,
    true
  )
  assert.equal(
    LOCAL_TOOL_INPUTS.click.safeParse({ app: "Finder", x: "10", y: 20 })
      .success,
    false
  )
  assert.equal(
    LOCAL_TOOL_INPUTS.type.safeParse({
      app: "Finder",
      text: "x".repeat(100_001),
    }).success,
    false
  )
  assert.equal(
    LOCAL_TOOL_INPUTS.script.safeParse({
      source: "tell application \"Finder\" to get name",
      language: "AppleScript",
    }).success,
    true
  )
  assert.equal(
    LOCAL_TOOL_INPUTS.script.safeParse({ source: "x", language: "Python" })
      .success,
    false
  )
  assert.equal(
    LOCAL_TOOL_INPUTS.exec.safeParse({ source: "print(mac.list_apps())" })
      .success,
    true
  )
}

testProtocolVersion()
testProviderFixtures()
testAxiomPreview()
await testAxiomSyncPreview()
testRedaction()
testDedupeAndConflicts()
await testAtomicConcurrency()
await testSerializedGuardedMerge()
await testGuardedAtomicMerge()
testAcpProjection()
await testManagedDefinitions()
await testMakoRuntimeProjection()
testLocalSchemas()
console.log("MCP tests passed")
