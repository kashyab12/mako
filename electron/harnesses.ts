import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
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

const OpenCodeModelIdentitySchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
})
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

const cache = new Map<string, { at: number; profile: HarnessProfile }>()

export async function harnessProfile(harness: string): Promise<HarnessProfile> {
  const env = await accountEnv(harness, process.env)
  const key = `${harness}:${env.CLAUDE_CONFIG_DIR ?? ""}:${env.CODEX_HOME ?? ""}`
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

export function openCodeExecutable(): string | null {
  const configured = process.env["OPENCODE_BIN_PATH"]
  if (configured && existsSync(configured)) return configured
  const bundled = join(homedir(), ".opencode", "bin", "opencode")
  if (existsSync(bundled)) return bundled
  return null
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
  const executable = openCodeExecutable()
  if (!executable) throw new Error("OpenCode is not installed")
  const output = await run(executable, ["models", "--verbose"], env)
  const catalog = normalizeOpenCodeModels(parseOpenCodeModels(output))
  const configured = await latestOpenCodeModel()
  if (configured && catalog.models.some((model) => model.id === configured)) {
    catalog.configuredModel = configured
    catalog.defaultModel = configured
  } else {
    catalog.defaultModel = catalog.models[0]?.id
  }
  return availableHarnessProfile("opencode", catalog)
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

async function latestOpenCodeModel(): Promise<string | undefined> {
  const sqlite = await import("node:sqlite").catch(() => null)
  if (!sqlite) return undefined
  for (const databaseName of ["opencode-next.db", "opencode.db"]) {
    const path = join(
      homedir(),
      ".local",
      "share",
      "opencode",
      databaseName
    )
    if (!existsSync(path)) continue
    let database: import("node:sqlite").DatabaseSync | undefined
    try {
      database = new sqlite.DatabaseSync(path, { readOnly: true })
      const columns = new Set(
        database.prepare("PRAGMA table_info(session)").all().map((row) => row.name)
      )
      if (columns.has("model")) {
        const current = database
          .prepare(
            "SELECT model FROM session WHERE model IS NOT NULL ORDER BY time_updated DESC LIMIT 1"
          )
          .get()
        const currentModel = OpenCodeModelIdentitySchema.safeParse(
          current?.model ? JSON.parse(String(current.model)) : null
        )
        if (currentModel.success) {
          return `${currentModel.data.providerID}/${currentModel.data.modelID}`
        }
      }
      const tables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name)
      )
      if (tables.has("message")) {
        const legacy = database
          .prepare(
            "SELECT data FROM message WHERE json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 1"
          )
          .get()
        const parsed = OpenCodeModelIdentitySchema.safeParse(
          legacy?.data ? JSON.parse(String(legacy.data)) : null
        )
        if (parsed.success)
          return `${parsed.data.providerID}/${parsed.data.modelID}`
      }
    } catch {
      continue
    } finally {
      database?.close()
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
