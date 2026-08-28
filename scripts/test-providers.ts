import assert from "node:assert/strict"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { resolveAcpConfigValue } from "../electron/acp-config.ts"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../electron/executable.ts"
import { ProviderProfileCache } from "../electron/provider-profile-cache.ts"
import type { ProviderAccountCapability } from "../electron/providers/account-capability.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { NativeRunner } from "../electron/providers/native-runner.ts"
import { ProviderRegistry } from "../electron/providers/registry.ts"

const cursorModelOption = {
  type: "select",
  id: "model",
  name: "Model",
  currentValue: "claude-opus-5[thinking=true,context=300k,effort=high]",
  options: [
    {
      value: "claude-opus-5[thinking=true,context=300k,effort=high]",
      name: "claude-opus-5",
    },
  ],
} satisfies SessionConfigOption
assert.equal(
  resolveAcpConfigValue(cursorModelOption, "claude-opus-5"),
  "claude-opus-5[thinking=true,context=300k,effort=high]"
)

const executableHome = await mkdtemp(join(tmpdir(), "mako-executable-"))
try {
  const bin = join(
    executableHome,
    ".nvm",
    "versions",
    "node",
    "v24.19.0",
    "bin"
  )
  const codex = join(bin, "codex")
  await mkdir(bin, { recursive: true })
  await writeFile(codex, "#!/bin/sh\nexit 0\n")
  await chmod(codex, 0o755)
  assert.equal(
    resolveExecutable("codex", { PATH: "/usr/bin:/bin" }, executableHome),
    codex
  )
  assert.equal(
    environmentForExecutable(codex, { PATH: "/usr/bin:/bin" }).PATH,
    `${bin}:/usr/bin:/bin`
  )
} finally {
  await rm(executableHome, { recursive: true, force: true })
}

const cacheDir = await mkdtemp(join(tmpdir(), "mako-provider-cache-"))
const cachePath = join(cacheDir, "profiles.json")
const cachedProfile = {
  id: "cursor",
  label: "Cursor",
  available: true,
  transport: "acp",
  models: [],
  capabilities: ["models"],
} satisfies HarnessProfile
try {
  const firstCache = new ProviderProfileCache(cachePath)
  await firstCache.put("cursor:default", cachedProfile)
  await firstCache.put("cursor:other", cachedProfile)
  const restartedCache = new ProviderProfileCache(cachePath)
  assert.deepEqual(await restartedCache.get("cursor:default"), cachedProfile)
  const cacheFileSchema = z.object({
    snapshots: z.record(z.string(), z.unknown()),
  })
  const stored = cacheFileSchema.parse(JSON.parse(await readFile(cachePath, "utf8")))
  assert.equal(Object.keys(stored.snapshots).length, 1)
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}

const providers = providerHost.profiles.list().map((loader) => loader.provider)
assert.ok(providers.length > 0)
assert.equal(new Set(providers).size, providers.length)
assert.deepEqual(
  providerHost.nativeRunners.list().map((runner) => runner.provider),
  providers
)
assert.deepEqual(
  providerHost.mcpSources.list().map((source) => source.provider),
  providers
)
assert.deepEqual(
  providerHost.skillSources.list().map((source) => source.provider),
  providers
)
assert.deepEqual(
  providerHost.acpSources.list().map((source) => source.provider),
  ["claude", "cursor", "grok", "devin", "opencode"]
)
assert.deepEqual(
  providerHost.sessionEmitters.list().map((emitter) => emitter.provider),
  ["claude", "codex", "cursor", "grok"]
)
assert.equal(
  providerHost.nativeRunners.get("claude")?.fastMode,
  "unsupported"
)
assert.deepEqual(
  providerHost.accountCapabilities
    .list()
    .map((capability) => [capability.provider, capability.mode]),
  [
    ["claude", "selectable"],
    ["codex", "selectable"],
    ["opencode", "observed"],
  ]
)
assert.equal(providerHost.accountCapabilities.get("cursor"), undefined)
const accountCapability: ProviderAccountCapability =
  providerHost.accountCapabilities.get("claude")!
assert.equal(accountCapability.mode, "selectable")

const claude = providerHost.nativeRunners.get("claude")!
assert.deepEqual(claude.resume("session", "continue", {
  model: "opus",
  effort: "high",
}), {
  command: "claude",
  args: [
    "-p",
    "continue",
    "--resume",
    "session",
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--effort",
    "high",
  ],
})

const codex = providerHost.nativeRunners.get("codex")!
assert.deepEqual(
  codex.resume("session", "continue", {
    model: "gpt-5",
    effort: "high",
    options: { serviceTier: "fast" },
  }),
  {
    command: "codex",
    args: [
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-m",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'service_tier="fast"',
      "resume",
      "session",
      "continue",
    ],
  }
)

const cursor = providerHost.nativeRunners.get("cursor")!
assert.deepEqual(
  cursor.fresh("start", {
    model: "sonnet",
    effort: "high",
    fast: true,
  }),
  {
    command: "cursor-agent",
    args: [
      "-p",
      "start",
      "--force",
      "--model",
      "sonnet[effort=high,fast=true]",
    ],
  }
)

const grok = providerHost.nativeRunners.get("grok")!
assert.deepEqual(grok.resume("session", "continue", { effort: "high" }), {
  command: "agent",
  args: [
    "-p",
    "continue",
    "--resume",
    "session",
    "--always-approve",
    "--reasoning-effort",
    "high",
  ],
})

const devin = providerHost.nativeRunners.get("devin")!
assert.deepEqual(
  devin.fresh("start", { model: "adaptive" }).args,
  [
    "-p",
    "start",
    "--permission-mode",
    "smart",
    "--respect-workspace-trust",
    "false",
    "--model",
    "adaptive",
  ]
)

const openCode = providerHost.nativeRunners.get("opencode")!
const openCodeFresh = openCode.fresh("start", { model: "openai/gpt" })
assert.equal(openCodeFresh.args[0], "run")
assert.equal(openCodeFresh.args.at(-1), "start")
assert.ok(openCodeFresh.args.includes("openai/gpt"))

const cursorAcp = await providerHost.acpSources.get("cursor")!.launch({
  appPath: process.cwd(),
  execPath: process.execPath,
})
assert.deepEqual(
  cursorAcp && { command: cursorAcp.command, args: cursorAcp.args },
  { command: "cursor-agent", args: ["acp"] }
)

const grokAcp = await providerHost.acpSources.get("grok")!.launch({
  appPath: process.cwd(),
  execPath: process.execPath,
  tuning: { effort: "high" },
})
assert.deepEqual(grokAcp?.args, [
  "agent",
  "--no-leader",
  "--reasoning-effort",
  "high",
  "stdio",
])
const grokEnv: NodeJS.ProcessEnv = {}
grokAcp?.configureEnvironment(grokEnv)
assert.equal(grokEnv.GROK_DISABLE_AUTOUPDATER, "1")

const claudeSource = providerHost.acpSources.get("claude")!
if (claudeSource.available(process.cwd())) {
  const claudeAcp = await claudeSource.launch({
    appPath: process.cwd(),
    execPath: "/fixture/electron",
    tuning: { options: { agentTeams: true } },
  })
  assert.equal(claudeAcp?.command, "/fixture/electron")
  const claudeEnv: NodeJS.ProcessEnv = {}
  claudeAcp?.configureEnvironment(claudeEnv)
  assert.equal(claudeEnv.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(claudeEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1")
}

const openCodeSource = providerHost.acpSources.get("opencode")!
if (openCodeSource.available(process.cwd())) {
  const openCodeAcp = await openCodeSource.launch({
    appPath: process.cwd(),
    execPath: process.execPath,
  })
  assert.deepEqual(openCodeAcp?.args, ["acp"])
}

const registry = new ProviderRegistry<NativeRunner>()
const runner: NativeRunner = {
  provider: "fixture",
  fastMode: "supported",
  resume: () => ({ command: "fixture", args: [] }),
  fresh: () => ({ command: "fixture", args: [] }),
}
const dispose = registry.register(runner)
assert.equal(registry.get("fixture"), runner)
assert.throws(() => registry.register(runner), /already registered/)
dispose()
assert.equal(registry.get("fixture"), undefined)
dispose()

console.log("Provider composition and native runner checks passed")
