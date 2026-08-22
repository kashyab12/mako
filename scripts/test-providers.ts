import assert from "node:assert/strict"
import { providerHost } from "../electron/providers/index.ts"
import type { NativeRunner } from "../electron/providers/native-runner.ts"
import { ProviderRegistry } from "../electron/providers/registry.ts"

const providers = ["claude", "codex", "cursor", "grok", "devin", "opencode"]
assert.deepEqual(
  providerHost.nativeRunners.list().map((runner) => runner.provider),
  providers
)
assert.deepEqual(
  providerHost.profiles.list().map((loader) => loader.provider),
  providers
)

const codex = providerHost.nativeRunners.get("codex")!
assert.deepEqual(codex.resume("session", "continue", {
  model: "gpt-5",
  effort: "high",
  options: { serviceTier: "fast" },
}), {
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
})

const cursor = providerHost.nativeRunners.get("cursor")!
assert.deepEqual(cursor.fresh("start", {
  model: "sonnet",
  effort: "high",
  fast: true,
}), {
  command: "cursor-agent",
  args: ["-p", "start", "--force", "--model", "sonnet[effort=high,fast=true]"],
})

const registry = new ProviderRegistry<NativeRunner>()
const runner: NativeRunner = {
  provider: "fixture",
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
