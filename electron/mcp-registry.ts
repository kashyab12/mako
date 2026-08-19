import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { accountEnv, selectedAccount } from "./accounts.js"
import { devinExecutable } from "./harnesses.js"
import type { JsonValue } from "./codex-app-json.js"
import type {
  McpRegistryProviderStatus,
  McpRegistrySnapshot,
  McpServerDefinition,
  McpServerOrigin,
  McpServerRecord,
  McpTransport,
} from "./shared.js"

const run = promisify(execFile)
const PROVIDERS = ["claude", "codex", "cursor", "grok", "devin"] as const
const SECRET_KEY =
  /(?:authorization|api[-_]?key|access[-_]?token|bearer|credential|oauth|password|secret|token)/i
const MAX_CLI_OUTPUT = 4 * 1024 * 1024

type Provider = (typeof PROVIDERS)[number]
const StringMapSchema = z.record(z.string(), z.string()).catch({})
const OptionalStringSchema = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined)
const RawTransportSchema = z
  .object({
    type: OptionalStringSchema,
    command: OptionalStringSchema,
    args: z.array(z.string()).catch([]),
    url: OptionalStringSchema,
    env: StringMapSchema,
    headers: StringMapSchema,
    http_headers: StringMapSchema,
    env_http_headers: StringMapSchema,
    env_vars: z.array(z.string()).catch([]),
    bearer_token_env_var: OptionalStringSchema,
  })
  .passthrough()
const RawDefinitionSchema = RawTransportSchema.extend({
  name: OptionalStringSchema,
  auth_status: OptionalStringSchema,
  transport: RawTransportSchema.optional(),
})
const JsonMapSchema = z.record(z.string(), z.json())
const NamedRootSchema = z
  .object({
    mcpServers: JsonMapSchema.optional(),
    mcp_servers: JsonMapSchema.optional(),
    servers: JsonMapSchema.optional(),
  })
  .catchall(z.json())

interface CleanUrlResult {
  url: string
  inlineSecret: boolean
}

export interface McpInternalDefinition extends McpServerDefinition {
  env?: Record<string, string>
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
}

export interface McpDiscoveredDefinition {
  definition: McpInternalDefinition
  origin: McpServerOrigin
}

export interface McpDiscoveryRoute {
  provider: Provider
  account: string
  cwd: string
  env: NodeJS.ProcessEnv
  userFiles: string[]
  workspaceFiles: string[]
}

function cleanUrl(value: string): CleanUrlResult {
  try {
    const url = new URL(value)
    let inlineSecret = Boolean(url.username || url.password)
    url.username = ""
    url.password = ""
    for (const key of url.searchParams.keys()) {
      if (!SECRET_KEY.test(key)) continue
      url.searchParams.delete(key)
      inlineSecret = true
    }
    return { url: url.toString(), inlineSecret }
  } catch {
    return { url: value, inlineSecret: SECRET_KEY.test(value) }
  }
}

function transportValue(
  value: string | undefined,
  fallback: McpTransport
): McpTransport {
  if (value === "stdio") return "stdio"
  if (value === "sse") return "sse"
  if (
    value === "http" ||
    value === "streamable_http" ||
    value === "streamable-http"
  )
    return "http"
  return fallback
}

function parseDefinition(
  name: string,
  value: JsonValue
): McpInternalDefinition | null {
  const parsed = RawDefinitionSchema.safeParse(value)
  if (!parsed.success) return null
  const root = parsed.data
  const source = root.transport ?? root
  const command = source.command
  const rawUrl = source.url
  if (!command && !rawUrl) return null
  let redactNextArgument = false
  const args = source.args.map((argument) => {
    if (redactNextArgument) {
      redactNextArgument = false
      return "[redacted]"
    }
    if (!SECRET_KEY.test(argument)) return argument
    redactNextArgument = !argument.includes("=")
    return "[redacted]"
  })
  const env = source.env
  const headers = { ...source.headers, ...source.http_headers }
  const envNames = new Set([
    ...Object.keys(env),
    ...source.env_vars,
    ...Object.values(source.env_http_headers),
  ])
  const headerNames = new Set([
    ...Object.keys(headers),
    ...Object.keys(source.env_http_headers),
  ])
  const bearerTokenEnvVar = source.bearer_token_env_var
  if (bearerTokenEnvVar) envNames.add(bearerTokenEnvVar)
  const cleaned = rawUrl ? cleanUrl(rawUrl) : undefined
  const blockReasons: string[] = []
  if (Object.keys(env).length > 0)
    blockReasons.push("contains inline environment values")
  if (Object.keys(headers).length > 0)
    blockReasons.push("contains inline header values")
  if (bearerTokenEnvVar)
    blockReasons.push("uses a provider-owned bearer-token environment mapping")
  if (Object.keys(source.env_http_headers).length > 0)
    blockReasons.push("uses provider-owned environment header mappings")
  if (args.some((argument) => argument === "[redacted]"))
    blockReasons.push("contains credentials in command arguments")
  if (cleaned?.inlineSecret)
    blockReasons.push("contains credentials in its URL")
  const fallback: McpTransport = command ? "stdio" : "http"
  const result: McpInternalDefinition = {
    name,
    transport: transportValue(source.type ?? root.type, fallback),
    envNames: [...envNames].sort(),
    headerNames: [...headerNames].sort(),
    portable: blockReasons.length === 0,
  }
  if (command) {
    result.command = command
    result.args = args
  }
  if (cleaned) result.url = cleaned.url
  if (blockReasons.length > 0) result.blockReason = blockReasons.join("; ")
  if (Object.keys(env).length > 0) result.env = env
  if (Object.keys(headers).length > 0) result.headers = headers
  if (bearerTokenEnvVar) result.bearerTokenEnvVar = bearerTokenEnvVar
  return result
}

function parseNamedMap(value: JsonValue): McpInternalDefinition[] {
  const parsedRoot = NamedRootSchema.safeParse(value)
  if (!parsedRoot.success) return []
  const root = parsedRoot.data
  const servers = root.mcpServers ?? root.mcp_servers ?? root.servers ?? root
  const parsed: McpInternalDefinition[] = []
  for (const [name, definition] of Object.entries(servers)) {
    const item = parseDefinition(name, definition)
    if (item) parsed.push(item)
  }
  return parsed
}

export function parseProviderJson(
  provider: Provider,
  contents: string
): McpInternalDefinition[] {
  const value = z.json().parse(JSON.parse(contents))
  if ((provider === "codex" || provider === "grok") && Array.isArray(value)) {
    return value.flatMap((entry) => {
      const parsed = RawDefinitionSchema.safeParse(entry)
      if (!parsed.success || !parsed.data.name) return []
      const definition = parseDefinition(parsed.data.name, entry)
      return definition ? [definition] : []
    })
  }
  return parseNamedMap(value)
}

function safeDefinition(
  definition: McpInternalDefinition
): McpServerDefinition {
  const safe: McpServerDefinition = {
    name: definition.name,
    transport: definition.transport,
    envNames: [...definition.envNames],
    headerNames: [...definition.headerNames],
    portable: definition.portable,
  }
  if (definition.command) safe.command = definition.command
  if (definition.args) safe.args = [...definition.args]
  if (definition.url) safe.url = definition.url
  if (definition.blockReason) safe.blockReason = definition.blockReason
  return safe
}

function bodyKey(definition: McpServerDefinition): string {
  return JSON.stringify({
    transport: definition.transport,
    command: definition.command ?? null,
    args: definition.args ?? [],
    url: definition.url ?? null,
    envNames: definition.envNames,
    headerNames: definition.headerNames,
  })
}

export function mergeMcpDefinitions(
  definitions: McpDiscoveredDefinition[]
): McpServerRecord[] {
  const grouped = new Map<string, McpServerRecord>()
  const namesByBody = new Map<string, Set<string>>()
  const bodiesByName = new Map<string, Set<string>>()
  for (const item of definitions) {
    const safe = safeDefinition(item.definition)
    const body = bodyKey(safe)
    namesByBody.set(body, (namesByBody.get(body) ?? new Set()).add(safe.name))
    bodiesByName.set(
      safe.name,
      (bodiesByName.get(safe.name) ?? new Set()).add(body)
    )
    const existing = grouped.get(body)
    if (existing) {
      if (!existing.origins.some((origin) => sameOrigin(origin, item.origin)))
        existing.origins.push(item.origin)
      continue
    }
    grouped.set(body, {
      ...safe,
      id: createHash("sha256").update(body).digest("hex").slice(0, 16),
      origins: [item.origin],
    })
  }
  const records = [...grouped.values()]
  for (const record of records) {
    const body = bodyKey(record)
    if ((bodiesByName.get(record.name)?.size ?? 0) > 1)
      record.conflict = "drift"
    else if ((namesByBody.get(body)?.size ?? 0) > 1) record.conflict = "name"
  }
  return records.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  )
}

function sameOrigin(left: McpServerOrigin, right: McpServerOrigin): boolean {
  return (
    left.provider === right.provider &&
    left.account === right.account &&
    left.scope === right.scope &&
    left.provenance === right.provenance
  )
}

async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const candidates = isAbsolute(command)
    ? [command]
    : [
        ...(env.PATH ?? "").split(delimiter).filter(Boolean),
        join(homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ].map((directory) => join(directory, command))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

async function canExecute(
  command: string,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  return (await findExecutable(command, env)) !== null
}

export async function mcpDiscoveryRoute(
  provider: Provider,
  cwd: string
): Promise<McpDiscoveryRoute> {
  const env = await accountEnv(provider, process.env)
  const selected = await selectedAccount(provider)
  const userFiles: string[] = []
  const workspaceFiles: string[] = []
  if (provider === "claude") {
    userFiles.push(
      selected.dir
        ? join(selected.dir, ".claude.json")
        : join(homedir(), ".claude.json")
    )
    workspaceFiles.push(join(cwd, ".mcp.json"))
  } else if (provider === "cursor") {
    userFiles.push(join(homedir(), ".cursor", "mcp.json"))
    workspaceFiles.push(join(cwd, ".cursor", "mcp.json"))
  } else if (provider === "devin") {
    userFiles.push(
      join(homedir(), ".config", "devin", "mcp_config.json"),
      join(homedir(), ".config", "devin", "mcp.json"),
      join(homedir(), ".devin", "mcp.json")
    )
    workspaceFiles.push(
      join(cwd, ".devin", "mcp_config.local.json"),
      join(cwd, ".devin", "mcp_config.json")
    )
  }
  return {
    provider,
    account: selected.name,
    cwd,
    env,
    userFiles,
    workspaceFiles,
  }
}

async function readJsonDefinitions(
  route: McpDiscoveryRoute
): Promise<McpDiscoveredDefinition[]> {
  const definitions: McpDiscoveredDefinition[] = []
  for (const [scope, files] of [
    ["user", route.userFiles],
    ["workspace", route.workspaceFiles],
  ] as const) {
    for (const file of files) {
      try {
        const parsed = parseProviderJson(
          route.provider,
          await readFile(file, "utf8")
        )
        for (const definition of parsed) {
          definitions.push({
            definition,
            origin: {
              provider: route.provider,
              account: route.account,
              scope,
              provenance: file,
            },
          })
        }
      } catch {
        continue
      }
    }
  }
  return definitions
}

async function readCliDefinitions(
  route: McpDiscoveryRoute
): Promise<McpDiscoveredDefinition[]> {
  if (route.provider !== "codex" && route.provider !== "grok") return []
  const command = route.provider
  if (!(await canExecute(command, route.env))) return []
  try {
    const { stdout } = await run(command, ["mcp", "list", "--json"], {
      cwd: route.cwd,
      env: route.env,
      timeout: 8_000,
      maxBuffer: MAX_CLI_OUTPUT,
      windowsHide: true,
    })
    return parseProviderJson(route.provider, stdout).map((definition) => ({
      definition,
      origin: {
        provider: route.provider,
        account: route.account,
        scope: "effective",
        provenance: `${command} mcp list --json`,
      },
    }))
  } catch {
    return []
  }
}

function localServerPath(appPath: string): string {
  return join(appPath, "dist-electron", "local-tools-main.js")
}

async function harnessDoctor(
  available: boolean,
  env: NodeJS.ProcessEnv
): Promise<string> {
  if (!available) return "macOS Harness is not installed"
  try {
    const { stdout, stderr } = await run("macos-harness", ["doctor"], {
      env,
      timeout: 8_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    const output = `${stdout}\n${stderr}`
    return /(?:missing|denied|not granted|required)/i.test(output)
      ? "Installed; macOS permissions need attention"
      : "Installed; doctor passed"
  } catch {
    return "Installed; doctor status unavailable"
  }
}

export async function managedMcpDefinitions(
  appPath: string,
  execPath = process.execPath,
  env: NodeJS.ProcessEnv = process.env
): Promise<McpDiscoveredDefinition[]> {
  const harnessPath = await findExecutable("macos-harness", env)
  const browserPath = await findExecutable("browser-use", env)
  const uvxPath = await findExecutable("uvx", env)
  const cuaPath = await findExecutable("cua-driver", env)
  const harness = harnessPath !== null
  const browser = browserPath !== null
  const uvx = uvxPath !== null
  const cuaSocket = env.MAKO_CUA_SOCKET
  const cua = cuaPath !== null && Boolean(cuaSocket)
  const doctor = await harnessDoctor(harness, env)
  const definitions: Array<
    McpInternalDefinition & { availability: boolean; detail: string }
  > = [
    {
      name: "mako-local-tools",
      transport: "stdio",
      command: process.platform === "win32" ? execPath : "/usr/bin/env",
      args:
        process.platform === "win32"
          ? [localServerPath(appPath)]
          : [
              "ELECTRON_RUN_AS_NODE=1",
              execPath,
              localServerPath(appPath),
            ],
      envNames:
        process.platform === "win32" ? ["ELECTRON_RUN_AS_NODE"] : [],
      headerNames: [],
      portable: true,
      availability: process.platform === "darwin" && harness,
      detail:
        process.platform === "darwin" ? doctor : "Available only on macOS",
    },
    {
      name: "browser-use",
      transport: "stdio",
      command: browserPath ?? uvxPath ?? "uvx",
      args: browser
        ? ["--cli-mcp"]
        : [
            "--from",
            "browser-use[cli]==0.13.7",
            "browser-use",
            "--cli-mcp",
          ],
      envNames: [],
      headerNames: [],
      portable: true,
      availability: browser || uvx,
      detail: browser
        ? "Browser Use 0.13.7 is installed"
        : uvx
          ? "Browser Use 0.13.7 is available through uvx"
          : "Browser Use and uvx are not installed",
    },
    {
      name: "mako-cua-fallback",
      transport: "stdio",
      command: cuaPath ?? "cua-driver",
      args: cuaSocket
        ? ["mcp", "--embedded", "--socket", cuaSocket]
        : ["mcp", "--embedded"],
      envNames: [],
      headerNames: [],
      portable: true,
      availability: cua,
      detail: cua
        ? "CUA Driver 0.19.3 fallback runs under Mako permissions"
        : cuaPath
          ? "Mako has not started its embedded CUA fallback"
          : "CUA Driver is not installed",
    },
  ]
  return definitions.map(({ availability, detail, ...definition }) => {
    if (!availability)
      definition.blockReason = "required command is not installed"
    return {
      definition,
      origin: {
        provider: "mako",
        account: "local",
        scope: "managed",
        provenance: availability
          ? `Mako managed (${detail})`
          : `Mako managed (unavailable: ${detail})`,
      },
    }
  })
}

function providerStatus(
  provider: Provider,
  route: McpDiscoveryRoute,
  available: boolean
): McpRegistryProviderStatus {
  return {
    id: provider,
    label:
      provider === "claude"
        ? "Claude Code"
        : provider[0].toUpperCase() + provider.slice(1),
    account: route.account,
    available,
    source: route.userFiles[0] ?? `${provider} mcp list --json`,
  }
}

export async function discoverMcpRegistry(
  cwd: string,
  appPath: string
): Promise<McpRegistrySnapshot> {
  const routes = await Promise.all(
    PROVIDERS.map((provider) => mcpDiscoveryRoute(provider, cwd))
  )
  const available = await Promise.all(
    routes.map((route) => {
      if (route.provider === "devin") return Boolean(devinExecutable())
      return canExecute(
        route.provider === "cursor" ? "cursor-agent" : route.provider,
        route.env
      )
    })
  )
  const discovered = (
    await Promise.all(
      routes.map(async (route) => [
        ...(await readJsonDefinitions(route)),
        ...(await readCliDefinitions(route)),
      ])
    )
  ).flat()
  const managed = await managedMcpDefinitions(appPath)
  const servers = mergeMcpDefinitions([...discovered, ...managed])
  await Promise.all(
    servers.map(async (server) => {
      const managedOrigin = server.origins.find(
        (origin) => origin.provider === "mako"
      )
      if (managedOrigin) {
        server.managed = true
        server.availability = managedOrigin.provenance.includes("(unavailable:")
          ? "unavailable"
          : "available"
        server.detail = managedOrigin.provenance.replace(/^Mako managed \(|\)$/g, "")
        return
      }
      if (server.transport === "stdio" && server.command) {
        server.availability = (await canExecute(server.command, process.env))
          ? "available"
          : "unavailable"
        return
      }
      server.availability = "unknown"
    })
  )
  return {
    cwd,
    generatedAt: Date.now(),
    servers,
    providers: routes.map((route, index) =>
      providerStatus(route.provider, route, available[index] ?? false)
    ),
  }
}

export function projectPortableDefinitions(
  snapshot: McpRegistrySnapshot,
  provider: Provider,
  transports: readonly McpTransport[]
): McpServerDefinition[] {
  const nativeNames = new Set(
    snapshot.servers
      .filter((server) =>
        server.origins.some((origin) => origin.provider === provider)
      )
      .map((server) => server.name)
  )
  return snapshot.servers
    .filter(
      (server) =>
        server.portable &&
        !server.origins.some((origin) => origin.provider === "mako") &&
        !server.conflict &&
        server.availability !== "unavailable" &&
        transports.includes(server.transport) &&
        !nativeNames.has(server.name)
    )
    .map(safeDefinition)
}

const MAKO_RUNTIME_SERVERS = new Set([
  "browser-use",
  "mako-local-tools",
  "mako-cua-fallback",
])

export function projectRuntimeDefinitions(
  snapshot: McpRegistrySnapshot,
  provider: Provider,
  transports: readonly McpTransport[]
): McpServerDefinition[] {
  const nativeNames = new Set(
    snapshot.servers
      .filter(
        (server) =>
          server.availability !== "unavailable" &&
          server.origins.some((origin) => origin.provider === provider)
      )
      .map((server) => server.name)
  )
  const nativeBrowser = [...nativeNames].some((name) =>
    /browser|chrome|playwright|node_repl/i.test(name)
  )
  const nativeComputer = [...nativeNames].some((name) =>
    /computer|cua|sky|node_repl/i.test(name)
  )
  return snapshot.servers
    .filter((server) => {
      const managed = server.origins.some(
        (origin) => origin.provider === "mako"
      )
      const managedRuntime =
        MAKO_RUNTIME_SERVERS.has(server.name) &&
        !server.blockReason &&
        (server.name !== "browser-use" || !nativeBrowser) &&
        (server.name !== "mako-local-tools" || !nativeComputer) &&
        (server.name !== "mako-cua-fallback" || !nativeComputer)
      return (
        server.portable &&
        !server.conflict &&
        server.availability !== "unavailable" &&
        transports.includes(server.transport) &&
        !nativeNames.has(server.name) &&
        (!managed || managedRuntime)
      )
    })
    .map(safeDefinition)
}
