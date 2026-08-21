import { spawn } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import { accountEnv } from "./accounts.js"
import {
  availableHarnessProfile,
  normalizeClaudeModels,
  normalizeCodexModels,
  normalizeCursorModels,
  normalizeDevinModels,
  normalizeGrokModels,
  normalizeOpenCodeModels,
  preferredOpenCodeDefault,
  unavailableHarnessProfile,
  type ClaudeModelRow,
  type CodexModelListResponse,
  type CursorConfig,
  type CursorModelListResponse,
  type DevinModelListResponse,
  type GrokModelCache,
  type OpenCodeModelRow,
} from "./harness-models.js"
import type { HarnessProfile } from "./shared.js"

export { normalizeAcpOptions, resolveHarnessTuning } from "./harness-models.js"

interface ClaudeControlRequest {
  type: string
  request_id: string
  request: { subtype: string }
}

interface ClaudeControlMessage {
  type?: string
  response?: {
    subtype?: string
    response?: { models?: ClaudeModelRow[] }
  }
}

interface RpcOutbound {
  id?: number
  method: string
  params: object
}

interface RpcInbound<TResult> {
  id?: number
  result: TResult
  error?: { message?: string }
}

const OpenCodeModelSchema = z.object({
  id: z.string(),
  providerID: z.string(),
  name: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  variants: z
    .record(
      z.string(),
      z.object({ reasoningEffort: z.string().optional() }).passthrough()
    )
    .optional(),
  limit: z
    .object({ context: z.number().optional(), output: z.number().optional() })
    .optional(),
  capabilities: z
    .object({
      reasoning: z.boolean().optional(),
      input: z
        .object({ text: z.boolean().optional(), image: z.boolean().optional() })
        .optional(),
    })
    .optional(),
})

const OpenCodeCacheModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    family: z.string().optional(),
    status: z.string().optional(),
    reasoning: z.boolean().optional(),
    reasoning_options: z
      .union([
        z.record(z.string(), z.unknown()),
        z.array(
          z.object({
            type: z.string(),
            values: z.array(z.string()),
          })
        ),
      ])
      .optional(),
    attachment: z.boolean().optional(),
    limit: z
      .object({
        context: z.number().optional(),
        output: z.number().optional(),
      })
      .optional(),
  })
  .passthrough()

const OpenCodeCacheProviderSchema = z
  .object({ models: z.record(z.string(), z.unknown()) })
  .passthrough()
const OpenCodeCacheSchema = z.record(z.string(), z.unknown())

const OpenCodeConfigSchema = z.object({ model: z.string().optional() }).passthrough()

const cache = new Map<string, { at: number; profile: HarnessProfile }>()

export async function harnessProfile(harness: string): Promise<HarnessProfile> {
  const env = await accountEnv(harness, process.env)
  let openCodeAuth = ""
  if (harness === "opencode") {
    try {
      const info = statSync(
        join(homedir(), ".local", "share", "opencode", "auth.json")
      )
      openCodeAuth = `${info.mtimeMs}:${info.size}`
    } catch {
      openCodeAuth = "missing"
    }
  }
  const key = `${harness}:${env.CLAUDE_CONFIG_DIR ?? ""}:${env.CODEX_HOME ?? ""}:${openCodeAuth}`
  const now = Date.now()
  for (const [cachedKey, cached] of cache) {
    if (now - cached.at >= 30_000) cache.delete(cachedKey)
  }
  const held = cache.get(key)
  if (held) return held.profile
  let profile: HarnessProfile
  try {
    profile =
      harness === "claude"
        ? await claudeProfile(env)
        : harness === "codex"
          ? await codexProfile(env)
          : harness === "cursor"
            ? await cursorProfile(env)
            : harness === "grok"
              ? await grokProfile(env)
              : harness === "devin"
                ? await devinProfile(env)
                : harness === "opencode"
                  ? await openCodeProfile(env)
                  : unavailableHarnessProfile(harness, "Unknown provider")
  } catch (error) {
    profile = unavailableHarnessProfile(harness, error instanceof Error ? error.message : String(error))
  }
  cache.set(key, { at: Date.now(), profile })
  return profile
}

export async function harnessProfiles(): Promise<HarnessProfile[]> {
  return Promise.all(
    ["claude", "codex", "cursor", "grok", "devin", "opencode"].map(
      harnessProfile
    )
  )
}

export interface OpenCodeInstallation {
  command: string
  generation: "v1" | "v2"
}

export function openCodeInstallation(
  preferred?: OpenCodeInstallation["generation"]
): OpenCodeInstallation | null {
  const configured = process.env["OPENCODE_BIN_PATH"]
  if (configured && existsSync(configured)) {
    const installation: OpenCodeInstallation = {
      command: configured,
      generation: basename(configured).toLowerCase().startsWith("opencode2")
        ? "v2"
        : "v1",
    }
    if (!preferred || installation.generation === preferred) return installation
  }
  const configuredV2 = process.env["OPENCODE2_BIN_PATH"]
  const v2 =
    configuredV2 && existsSync(configuredV2)
      ? configuredV2
      : join(homedir(), ".opencode", "bin", "opencode2")
  const configuredV1 = process.env["OPENCODE1_BIN_PATH"]
  const v1 =
    configuredV1 && existsSync(configuredV1)
      ? configuredV1
      : join(homedir(), ".opencode", "bin", "opencode")
  if (preferred === "v1") {
    return existsSync(v1) ? { command: v1, generation: "v1" } : null
  }
  if (preferred === "v2") {
    return existsSync(v2) ? { command: v2, generation: "v2" } : null
  }
  if (existsSync(v2)) return { command: v2, generation: "v2" }
  return existsSync(v1) ? { command: v1, generation: "v1" } : null
}

export function openCodeExecutable(): string | null {
  return openCodeInstallation()?.command ?? null
}

export async function openCodeSessionGeneration(
  sessionId: string
): Promise<OpenCodeInstallation["generation"]> {
  const sqlite = await import("node:sqlite").catch(() => null)
  if (!sqlite) return openCodeInstallation()?.generation ?? "v1"
  for (const name of ["opencode.db", "opencode-next.db"]) {
    const path = join(homedir(), ".local", "share", "opencode", name)
    if (!existsSync(path)) continue
    let database: import("node:sqlite").DatabaseSync | undefined
    try {
      database = new sqlite.DatabaseSync(path, { readOnly: true })
      const tables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name)
      )
      if (
        tables.has("session_v2") &&
        database.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(sessionId)
      ) {
        return "v2"
      }
      if (
        tables.has("session") &&
        database.prepare("SELECT 1 FROM session WHERE id = ?").get(sessionId)
      ) {
        return name === "opencode-next.db" ? "v2" : "v1"
      }
    } catch {
      continue
    } finally {
      database?.close()
    }
  }
  return openCodeInstallation()?.generation ?? "v1"
}

export function devinExecutable(): string | null {
  const configured = process.env["DEVIN_CLI_PATH"]
  if (configured && existsSync(configured)) return configured
  const direct = join(homedir(), ".local", "bin", "devin")
  if (existsSync(direct)) return direct
  if (process.platform !== "darwin") return null
  const registry = join(homedir(), "Library", "Application Support", "Zed", "external_agents", "registry", "devin")
  try {
    for (const version of readdirSync(registry).sort().reverse()) {
      const executable = join(registry, version, "bin", "devin")
      if (existsSync(executable)) return executable
    }
  } catch {
    return null
  }
  return null
}

async function claudeProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const response = await streamRequest<ClaudeControlMessage, ClaudeModelRow[]>(
    "claude",
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { type: "control_request", request_id: "mako-model-discovery", request: { subtype: "list_models" } },
    env,
    (message) => {
      return message.type === "control_response" && message.response?.subtype === "success"
        ? message.response.response?.models
        : undefined
    }
  )
  return availableHarnessProfile("claude", normalizeClaudeModels(response))
}

async function codexProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const result = await rpcRequest<CodexModelListResponse>("codex", ["app-server"], "model/list", env, false)
  return availableHarnessProfile("codex", normalizeCodexModels(result))
}

async function cursorProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const result = await rpcRequest<CursorModelListResponse>("cursor-agent", ["acp"], "cursor/list_available_models", env, true)
  const configured = await readJson<CursorConfig>(
    join(homedir(), ".cursor", "cli-config.json")
  )
  return availableHarnessProfile(
    "cursor",
    normalizeCursorModels(result, configured?.model?.modelId)
  )
}

async function grokProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const executable = existsSync(join(homedir(), ".grok", "bin", "grok")) ? join(homedir(), ".grok", "bin", "grok") : "grok"
  const output = await run(executable, ["models"], env)
  const cached = await readJson<GrokModelCache>(join(homedir(), ".grok", "models_cache.json"))
  return availableHarnessProfile("grok", normalizeGrokModels(output, cached))
}

async function devinProfile(
  env: NodeJS.ProcessEnv
): Promise<HarnessProfile> {
  const executable = devinExecutable()
  if (!executable) throw new Error("Devin CLI is not installed")
  const parsed: DevinModelListResponse = JSON.parse(
    await run(executable, ["models", "list", "--format", "json"], env)
  )
  return availableHarnessProfile("devin", normalizeDevinModels(parsed))
}

async function openCodeProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const installation = openCodeInstallation()
  if (!installation) throw new Error("OpenCode is not installed")
  const output = await run(
    installation.command,
    installation.generation === "v2" ? ["models"] : ["models", "--verbose"],
    env
  )
  const rows =
    installation.generation === "v2"
      ? await openCodeV2Models(output)
      : parseOpenCodeModels(output)
  const catalog = normalizeOpenCodeModels(rows)
  const configured = await configuredOpenCodeModel()
  if (configured && catalog.models.some((model) => model.id === configured)) {
    catalog.configuredModel = configured
    catalog.defaultModel = configured
  } else {
    catalog.defaultModel = preferredOpenCodeDefault(catalog.models)
  }
  return availableHarnessProfile("opencode", catalog)
}

async function openCodeV2Models(output: string): Promise<OpenCodeModelRow[]> {
  let cached: z.infer<typeof OpenCodeCacheSchema> = {}
  try {
    const parsed = OpenCodeCacheSchema.safeParse(
      JSON.parse(
        await readFile(join(homedir(), ".cache", "opencode", "models.json"), "utf8")
      )
    )
    if (parsed.success) cached = parsed.data
  } catch {
    cached = {}
  }

  return output.split(/\r?\n/).flatMap((line): OpenCodeModelRow[] => {
    const identity = line.trim()
    const separator = identity.indexOf("/")
    if (separator <= 0) return []
    const providerID = identity.slice(0, separator)
    const id = identity.slice(separator + 1)
    const cachedProvider = OpenCodeCacheProviderSchema.safeParse(
      cached[providerID]
    )
    const cachedModel = OpenCodeCacheModelSchema.safeParse(
      cachedProvider.success ? cachedProvider.data.models[id] : undefined
    )
    const baseId = id.endsWith("-fast") ? id.slice(0, -5) : id
    const cachedBase = OpenCodeCacheModelSchema.safeParse(
      cachedProvider.success ? cachedProvider.data.models[baseId] : undefined
    )
    const model = cachedModel.success
      ? cachedModel.data
      : cachedBase.success
        ? cachedBase.data
        : undefined
    const name =
      model && baseId !== id ? `${model.name} Fast` : model?.name
    const reasoning = Array.isArray(model?.reasoning_options)
      ? model.reasoning_options.flatMap((option) => option.values)
      : Object.keys(model?.reasoning_options ?? {})
    return [
      {
        providerID,
        id,
        name,
        family: model?.family,
        status: model?.status,
        variants:
          reasoning.length > 0
            ? Object.fromEntries(reasoning.map((value) => [value, {}]))
            : undefined,
        limit: model?.limit,
        capabilities: {
          reasoning: model?.reasoning,
          input: { text: true, image: model?.attachment },
        },
      },
    ]
  })
}

function parseOpenCodeModels(output: string): OpenCodeModelRow[] {
  const rows: OpenCodeModelRow[] = []
  let start = output.indexOf("{")
  while (start >= 0) {
    let depth = 0
    let quoted = false
    let escaped = false
    let end = start
    for (; end < output.length; end += 1) {
      const character = output[end]!
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\" && quoted) {
        escaped = true
        continue
      }
      if (character === '"') quoted = !quoted
      if (quoted) continue
      if (character === "{") depth += 1
      if (character === "}") depth -= 1
      if (depth === 0) {
        end += 1
        break
      }
    }
    try {
      const parsed = OpenCodeModelSchema.safeParse(
        JSON.parse(output.slice(start, end))
      )
      if (parsed.success) rows.push(parsed.data)
    } catch {
      return rows
    }
    start = output.indexOf("{", end)
  }
  return rows
}

async function configuredOpenCodeModel(): Promise<string | undefined> {
  for (const path of [
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), ".opencode", "config.json"),
  ]) {
    try {
      const parsed = OpenCodeConfigSchema.safeParse(
        JSON.parse(await readFile(path, "utf8"))
      )
      if (parsed.success && parsed.data.model) return parsed.data.model
    } catch {
      continue
    }
  }
  return undefined
}

async function readJson<TResult>(path: string): Promise<TResult | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`${command} discovery timed out`))
    }, 10_000)
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-8_000_000)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim().split("\n").at(-1) || `${command} exited with ${code}`))
    })
    child.stdin?.end(input)
  })
}

function streamRequest<TMessage, TResult>(
  command: string,
  args: string[],
  request: ClaudeControlRequest,
  env: NodeJS.ProcessEnv,
  pick: (value: TMessage) => TResult | undefined
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    let settled = false
    const finish = (value: TResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGTERM")
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill("SIGTERM")
        reject(new Error(`${command} discovery timed out`))
      }
    }, 10_000)
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const message: TMessage = JSON.parse(line)
          const selected = pick(message)
          if (selected !== undefined) finish(selected)
        } catch {
          continue
        }
      }
    })
    child.on("error", reject)
    child.stdin?.end(`${JSON.stringify(request)}\n`)
  })
}

function rpcRequest<TResult>(
  command: string,
  args: string[],
  method: string,
  env: NodeJS.ProcessEnv,
  jsonrpc: boolean
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    let initialized = false
    let settled = false
    const envelope = (value: RpcOutbound) => jsonrpc ? { jsonrpc: "2.0", ...value } : value
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill("SIGTERM")
        reject(new Error(`${command} protocol discovery timed out`))
      }
    }, 10_000)
    const send = (value: RpcOutbound) => child.stdin?.write(`${JSON.stringify(envelope(value))}\n`)
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const message: RpcInbound<TResult> = JSON.parse(line)
          if (message.id === 1 && !initialized) {
            if (message.error) throw new Error(message.error.message ?? "initialize failed")
            initialized = true
            send({ method: "initialized", params: {} })
            send({ id: 2, method, params: {} })
          } else if (message.id === 2) {
            settled = true
            clearTimeout(timer)
            child.kill("SIGTERM")
            if (message.error) reject(new Error(message.error.message ?? `${method} failed`))
            else resolve(message.result)
          }
        } catch (error) {
          if (!settled && error instanceof Error && error.message.includes("failed")) reject(error)
        }
      }
    })
    child.on("error", reject)
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
        capabilities: { experimentalApi: true },
      },
    })
  })
}
