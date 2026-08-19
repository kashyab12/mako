import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { accountEnv } from "./accounts.js"
import type { HarnessModel, HarnessModelOption, HarnessProfile, HarnessSelectValue } from "./shared.js"

const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  devin: "Devin",
}

const CAPABILITIES: Record<string, string[]> = {
  claude: ["start", "resume", "fork", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models"],
  codex: ["start", "resume", "fork-at-turn", "stream", "steer", "interrupt", "permissions", "images", "audio", "skills", "mcp", "models", "review"],
  cursor: ["start", "resume-acp", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models"],
  grok: ["start", "resume", "fork", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models", "memory"],
  devin: ["start", "resume", "stream", "interrupt", "permissions", "images", "commands", "mcp", "models", "cloud"],
}

const TRANSPORT: Record<string, HarnessProfile["transport"]> = {
  claude: "acp",
  codex: "app-server",
  cursor: "acp",
  grok: "acp",
  devin: "acp",
}

const cache = new Map<string, { at: number; profile: HarnessProfile }>()

export async function harnessProfile(harness: string): Promise<HarnessProfile> {
  const env = await accountEnv(harness, process.env)
  const key = `${harness}:${env.CLAUDE_CONFIG_DIR ?? ""}:${env.CODEX_HOME ?? ""}`
  const held = cache.get(key)
  if (held && Date.now() - held.at < 30_000) return held.profile
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
                : unavailable(harness, "Unknown provider")
  } catch (error) {
    profile = unavailable(harness, error instanceof Error ? error.message : String(error))
  }
  cache.set(key, { at: Date.now(), profile })
  return profile
}

export async function harnessProfiles(): Promise<HarnessProfile[]> {
  return Promise.all(["claude", "codex", "cursor", "grok", "devin"].map(harnessProfile))
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

function unavailable(harness: string, error: string): HarnessProfile {
  return {
    id: harness,
    label: LABELS[harness] ?? harness,
    available: false,
    transport: TRANSPORT[harness] ?? "remote",
    models: [],
    capabilities: CAPABILITIES[harness] ?? [],
    error,
  }
}

async function claudeProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const response = await streamRequest(
    "claude",
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { type: "control_request", request_id: "mako-model-discovery", request: { subtype: "list_models" } },
    env,
    (value) => {
      const record = value as { type?: string; response?: { subtype?: string; response?: { models?: unknown[] } } }
      return record.type === "control_response" && record.response?.subtype === "success"
        ? record.response.response?.models
        : undefined
    }
  )
  if (!Array.isArray(response)) throw new Error("Claude did not return its model catalog")
  let defaultModel: string | undefined
  let defaultResolved: string | undefined
  const models: HarnessModel[] = []
  for (const raw of response) {
    const model = raw as {
      value?: unknown
      resolvedModel?: unknown
      displayName?: unknown
      description?: unknown
      supportsEffort?: unknown
      supportedEffortLevels?: unknown
      supportsFastMode?: unknown
    }
    if (typeof model.value !== "string" || !model.value.trim()) continue
    if (model.value === "default") {
      if (typeof model.resolvedModel === "string") defaultResolved = model.resolvedModel
      continue
    }
    if (typeof model.resolvedModel === "string" && model.resolvedModel === defaultResolved) {
      defaultModel = model.value
    }
    const options: HarnessModelOption[] = []
    const efforts = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter((value): value is string => typeof value === "string")
      : []
    if (model.supportsEffort === true && efforts.length > 0) {
      options.push(selectOption("effort", "Reasoning", efforts))
    }
    if (model.supportsFastMode === true) options.push({ kind: "boolean", id: "fast", label: "Fast mode", current: false })
    models.push({
      id: model.value,
      label: typeof model.displayName === "string" ? model.displayName : model.value,
      ...(typeof model.description === "string" ? { description: model.description } : {}),
      options,
    })
  }
  return available("claude", models, defaultModel)
}

async function codexProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const result = await rpcRequest("codex", ["app-server"], "model/list", {}, env, false)
  const data = (result as { data?: unknown[] })?.data
  if (!Array.isArray(data)) throw new Error("Codex did not return its model catalog")
  let defaultModel: string | undefined
  const models = data.flatMap((raw): HarnessModel[] => {
    const model = raw as Record<string, unknown>
    const id = typeof model.model === "string" ? model.model : ""
    if (!id) return []
    if (model.isDefault === true) defaultModel = id
    const options: HarnessModelOption[] = []
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap((entry): HarnessSelectValue[] => {
          const value = (entry as { reasoningEffort?: unknown }).reasoningEffort
          return typeof value === "string"
            ? [{ value, label: effortLabel(value), default: value === model.defaultReasoningEffort }]
            : []
        })
      : []
    if (efforts.length > 0) options.push({ kind: "select", id: "effort", label: "Reasoning", current: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : undefined, values: efforts })
    const tiers = Array.isArray(model.serviceTiers)
      ? model.serviceTiers.flatMap((entry): HarnessSelectValue[] => {
          const tier = entry as { id?: unknown; name?: unknown; description?: unknown }
          return typeof tier.id === "string"
            ? [{ value: tier.id, label: typeof tier.name === "string" ? tier.name : tier.id, ...(typeof tier.description === "string" ? { description: tier.description } : {}) }]
            : []
        })
      : []
    if (tiers.length > 0) options.push({ kind: "select", id: "serviceTier", label: "Speed", current: typeof model.defaultServiceTier === "string" ? model.defaultServiceTier : undefined, values: tiers })
    return [{
      id,
      label: typeof model.displayName === "string" ? model.displayName : id,
      ...(typeof model.description === "string" ? { description: model.description } : {}),
      options,
    }]
  })
  return available("codex", models, defaultModel)
}

async function cursorProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const result = await rpcRequest("cursor-agent", ["acp"], "cursor/list_available_models", {}, env, true)
  const data = (result as { models?: unknown[] })?.models
  if (!Array.isArray(data)) throw new Error("Cursor did not return its model catalog")
  const models = data.flatMap((raw): HarnessModel[] => {
    const model = raw as { value?: unknown; name?: unknown; configOptions?: unknown[] }
    if (typeof model.value !== "string") return []
    return [{
      id: model.value,
      label: typeof model.name === "string" ? model.name : model.value,
      options: normalizeAcpOptions(model.configOptions),
    }]
  })
  const configured = await readJson(join(homedir(), ".cursor", "cli-config.json")) as { model?: { modelId?: string } } | null
  return available("cursor", models, configured?.model?.modelId ?? "auto-smart")
}

async function grokProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const executable = existsSync(join(homedir(), ".grok", "bin", "grok")) ? join(homedir(), ".grok", "bin", "grok") : "grok"
  const output = await run(executable, ["models"], env)
  const listed = new Map<string, string>()
  let reportedDefault: string | undefined
  for (const line of output.split(/\r?\n/)) {
    const model = /^(?:\*|-)\s+([^\s]+)(?:\s+\(default\))?$/.exec(line.trim())
    if (model) listed.set(model[1]!, model[1]!)
    const fallback = /^Default model:\s*(\S+)/.exec(line.trim())
    if (fallback) reportedDefault = fallback[1]
  }
  const cache = await readJson(join(homedir(), ".grok", "models_cache.json")) as {
    models?: Record<string, { info?: { name?: string; description?: string; context_window?: number; max_completion_tokens?: number; reasoning_effort?: string; reasoning_efforts?: Array<{ value?: string; label?: string; description?: string; default?: boolean }> } }>
  } | null
  const models: HarnessModel[] = []
  for (const [id, label] of listed) {
    const info = cache?.models?.[id]?.info
    const values = (info?.reasoning_efforts ?? []).flatMap((entry): HarnessSelectValue[] =>
      typeof entry.value === "string"
        ? [{ value: entry.value, label: entry.label ?? effortLabel(entry.value), ...(entry.description ? { description: entry.description } : {}), ...(entry.default ? { default: true } : {}) }]
        : []
    )
    models.push({
      id,
      label: info?.name ?? label,
      ...(info?.description ? { description: info.description } : {}),
      ...(info?.context_window ? { contextWindow: info.context_window } : {}),
      ...(info?.max_completion_tokens ? { maxOutputTokens: info.max_completion_tokens } : {}),
      options: values.length > 0 ? [{ kind: "select", id: "effort", label: "Reasoning", current: info?.reasoning_effort, values }] : [],
    })
  }
  return available("grok", models, reportedDefault)
}

async function devinProfile(env: NodeJS.ProcessEnv): Promise<HarnessProfile> {
  const executable = devinExecutable()
  if (!executable) throw new Error("Devin CLI is not installed")
  const parsed = JSON.parse(await run(executable, ["models", "list", "--format", "json"], env)) as { families?: unknown[] }
  const discovered = (parsed.families ?? []).flatMap((raw): HarnessModel[] => {
    const family = raw as { family_label?: unknown; slug?: unknown; aliases?: unknown[]; variants?: unknown[] }
    if (typeof family.slug !== "string") return []
    const variants = Array.isArray(family.variants) ? family.variants as Array<Record<string, unknown>> : []
    const efforts = new Map<string, HarnessSelectValue>()
    let fast = false
    for (const variant of variants) {
      const id = typeof variant.model_uid === "string" ? variant.model_uid : ""
      const label = typeof variant.label === "string" ? variant.label : id
      const effort = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "none"].find((value) => new RegExp(`(?:^|[- ])${value}(?:$|[- ])`, "i").test(`${id} ${label}`))
      if (effort && !efforts.has(effort)) efforts.set(effort, { value: effort, label: effortLabel(effort) })
      if (/(?:^|-)fast$|\bfast\b/i.test(`${id} ${label}`)) fast = true
    }
    const first = variants[0]
    const options: HarnessModelOption[] = []
    if (efforts.size > 0) options.push({ kind: "select", id: "effort", label: "Reasoning", values: [...efforts.values()] })
    if (fast) options.push({ kind: "boolean", id: "fast", label: "Fast mode", current: false })
    return [{
      id: family.slug,
      label: typeof family.family_label === "string" ? family.family_label : family.slug,
      ...(typeof first?.max_context_tokens === "number" ? { contextWindow: first.max_context_tokens } : {}),
      ...(typeof first?.max_output_tokens === "number" ? { maxOutputTokens: first.max_output_tokens } : {}),
      options,
    }]
  })
  const models: HarnessModel[] = [
    {
      id: "adaptive",
      label: "Adaptive",
      description: "Devin selects the model for each task.",
      options: [],
    },
    ...discovered,
  ]
  return available("devin", models, "adaptive")
}

function available(harness: string, models: HarnessModel[], defaultModel?: string): HarnessProfile {
  return {
    id: harness,
    label: LABELS[harness] ?? harness,
    available: true,
    transport: TRANSPORT[harness] ?? "remote",
    models,
    ...(defaultModel ? { defaultModel } : {}),
    capabilities: CAPABILITIES[harness] ?? [],
  }
}

function selectOption(id: string, label: string, values: string[]): HarnessModelOption {
  return { kind: "select", id, label, values: values.map((value) => ({ value, label: effortLabel(value) })) }
}

function effortLabel(value: string): string {
  if (value === "xhigh") return "Extra high"
  if (value === "ultra") return "Ultra"
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function normalizeAcpOptions(options: unknown): HarnessModelOption[] {
  if (!Array.isArray(options)) return []
  return options.flatMap((raw): HarnessModelOption[] => {
    const option = raw as { id?: unknown; name?: unknown; type?: unknown; currentValue?: unknown; options?: unknown }
    if (typeof option.id !== "string") return []
    const label = typeof option.name === "string" ? option.name : option.id
    if (option.type === "boolean") return [{ kind: "boolean", id: option.id, label, current: option.currentValue === true }]
    if (option.type !== "select") return []
    const flat = Array.isArray(option.options)
      ? option.options
      : typeof option.options === "object" && option.options !== null
        ? Object.values(option.options).flat()
        : []
    const values = flat.flatMap((entry): HarnessSelectValue[] => {
      const item = entry as { value?: unknown; name?: unknown; description?: unknown }
      return typeof item.value === "string"
        ? [{ value: item.value, label: typeof item.name === "string" ? item.name : item.value, ...(typeof item.description === "string" ? { description: item.description } : {}) }]
        : []
    })
    return values.length > 0 ? [{ kind: "select", id: option.id, label, current: typeof option.currentValue === "string" ? option.currentValue : undefined, values }] : []
  })
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
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

function streamRequest(
  command: string,
  args: string[],
  request: unknown,
  env: NodeJS.ProcessEnv,
  pick: (value: unknown) => unknown
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    let settled = false
    const finish = (value: unknown) => {
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
          const selected = pick(JSON.parse(line) as unknown)
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

function rpcRequest(
  command: string,
  args: string[],
  method: string,
  params: unknown,
  env: NodeJS.ProcessEnv,
  jsonrpc: boolean
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    let initialized = false
    let settled = false
    const envelope = (value: Record<string, unknown>) => jsonrpc ? { jsonrpc: "2.0", ...value } : value
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill("SIGTERM")
        reject(new Error(`${command} protocol discovery timed out`))
      }
    }, 10_000)
    const send = (value: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(envelope(value))}\n`)
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } }
          if (message.id === 1 && !initialized) {
            if (message.error) throw new Error(message.error.message ?? "initialize failed")
            initialized = true
            send({ method: "initialized", params: {} })
            send({ id: 2, method, params })
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
