import assert from "node:assert/strict"
import {
  availableHarnessProfile,
  canonicalHarnessModelId,
  normalizeClaudeModels,
  normalizeCodexModels,
  normalizeCursorModels,
  normalizeDevinModels,
  normalizeGrokModels,
  resolveHarnessTuning,
} from "../electron/harness-models.ts"
import { harnessProfiles } from "../electron/harnesses.ts"
import type { HarnessModel, HarnessProfile } from "../electron/shared.ts"

const claudeFixture = [
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default" },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "Frontier model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    supportsFastMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    supportsEffort: false,
  },
]

const codexFixture = {
  data: ["sol", "terra", "luna"].map((name, index) => ({
    model: `gpt-5.6-${name}`,
    displayName: `GPT-5.6 ${name[0]!.toUpperCase()}${name.slice(1)}`,
    isDefault: index === 0,
    defaultReasoningEffort: index === 0 ? "low" : "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Faster responses" },
    ],
  })),
}

const cursorFixture = {
  models: [
    { value: "auto-smart", name: "Auto", configOptions: [] },
    {
      value: "claude-opus-5[effort=high,fast=true]",
      name: "Claude Opus 5",
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          type: "select",
          currentValue: "true",
          options: {
            values: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        },
      ],
    },
  ],
}

const grokFixture = {
  output: [
    "Default model: grok-4.6",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
  ].join("\n"),
  cache: {
    models: {
      "grok-4.6": {
        info: {
          name: "Grok 4.6",
          context_window: 500_000,
          reasoning_effort: "high",
          reasoning_efforts: [
            { value: "low", label: "Low", default: false },
            { value: "high", label: "High", default: true },
          ],
        },
      },
      "grok-4.5": {
        info: {
          name: "Grok 4.5",
          reasoning_effort: "medium",
          reasoning_efforts: [{ value: "medium", label: "Medium", default: true }],
        },
      },
    },
  },
}

const devinFixture = {
  families: [
    {
      family_label: "Adaptive",
      slug: "adaptive",
      aliases: [],
      variants: [
        {
          model_uid: "adaptive",
          label: "Adaptive",
          description: "Automatically balances quality and cost",
        },
      ],
    },
    {
      family_label: "Adaptive duplicate",
      slug: "adaptive",
      aliases: [],
      variants: [{ model_uid: "adaptive-copy", label: "Adaptive copy" }],
    },
    {
      family_label: "GPT-5.6 Sol",
      slug: "gpt-5.6-sol",
      aliases: ["gpt"],
      variants: [
        {
          model_uid: "gpt-5-6-sol-medium",
          label: "GPT-5.6 Sol Medium Thinking",
          max_context_tokens: 1_000_000,
          max_output_tokens: 128_000,
        },
        {
          model_uid: "gpt-5-6-sol-high",
          label: "GPT-5.6 Sol High Thinking",
          max_context_tokens: 800_000,
          max_output_tokens: 96_000,
        },
        {
          model_uid: "gpt-5-6-sol-high-priority",
          label: "GPT-5.6 Sol High Thinking Fast",
          max_context_tokens: 700_000,
          max_output_tokens: 64_000,
        },
      ],
    },
  ],
}

function option(model: HarnessModel, id: string) {
  return model.options.find((entry) => entry.id === id)
}

function assertFixtureProfiles(): void {
  const claude = normalizeClaudeModels(claudeFixture)
  assert.equal(claude.defaultModel, "claude-opus-5[1m]")
  assert.deepEqual(
    claude.models.map(({ id, launchId, label }) => ({ id, launchId, label })),
    [
      { id: "claude-opus-5[1m]", launchId: "opus[1m]", label: "Opus (1M context)" },
      { id: "claude-sonnet-5", launchId: "sonnet", label: "Sonnet" },
    ]
  )
  const claudeProfile = availableHarnessProfile("claude", claude)
  assert.equal(resolveHarnessTuning(claudeProfile, { model: "claude-opus-5[1m]" })?.model, "opus[1m]")

  const codex = normalizeCodexModels(codexFixture)
  assert.deepEqual(
    codex.models.slice(0, 3).map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
  )
  assert.equal(codex.defaultModel, "gpt-5.6-sol")
  for (const model of codex.models) {
    const tier = option(model, "serviceTier")
    assert.equal(tier?.kind, "select")
    if (tier?.kind === "select") assert.deepEqual(tier.values.map((entry) => entry.value), ["priority"])
  }

  const cursor = normalizeCursorModels(
    cursorFixture,
    "claude-opus-5[effort=high,fast=true]"
  )
  assert.equal(cursor.defaultModel, "auto-smart")
  assert.equal(cursor.configuredModel, "claude-opus-5")
  const cursorModel = cursor.models.find((model) => model.id === "claude-opus-5")
  assert(cursorModel)
  assert.deepEqual(cursorModel.aliases, ["claude-opus-5[effort=high,fast=true]"])
  for (const entry of cursorModel.options) {
    if (entry.kind === "select") {
      assert(entry.values.every((value) => value.value === `${value.value}`))
    }
  }
  const fast = option(cursorModel, "fast")
  assert.equal(fast?.kind, "select")
  if (fast?.kind === "select") {
    assert.equal(fast.presentation, "toggle")
    assert.deepEqual(fast.values.map((entry) => entry.value), ["false", "true"])
  }

  const grok = normalizeGrokModels(grokFixture.output, grokFixture.cache)
  assert.equal(grok.defaultModel, "grok-4.6")
  assert.deepEqual(grok.models.map((model) => model.id), ["grok-4.6", "grok-4.5"])
  assert.deepEqual(
    grok.models.map((model) => option(model, "effort")?.kind === "select"
      ? option(model, "effort")!.values.map((entry) => entry.value)
      : []),
    [["low", "high"], ["medium"]]
  )

  const devin = normalizeDevinModels(devinFixture)
  assert.equal(devin.defaultModel, undefined)
  assert.equal(devin.models.filter((model) => model.id === "adaptive").length, 1)
  const sol = devin.models.find((model) => model.id === "gpt-5.6-sol")
  assert(sol)
  assert.equal(sol.launchId, "gpt-5-6-sol-medium")
  assert.deepEqual(
    sol.variants?.map(({ id, contextWindow, maxOutputTokens }) => ({ id, contextWindow, maxOutputTokens })),
    [
      { id: "gpt-5-6-sol-medium", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: "gpt-5-6-sol-high", contextWindow: 800_000, maxOutputTokens: 96_000 },
      { id: "gpt-5-6-sol-high-priority", contextWindow: 700_000, maxOutputTokens: 64_000 },
    ]
  )
  const devinProfile = availableHarnessProfile("devin", devin)
  const selected = { model: "gpt", effort: "high", fast: true }
  assert.equal(resolveHarnessTuning(devinProfile, selected)?.model, "gpt-5-6-sol-high-priority")
  assert.equal(resolveHarnessTuning(devinProfile, { model: "gpt-5.6-sol" })?.model, "gpt-5-6-sol-medium")
  assert.equal(canonicalHarnessModelId(devinProfile, "gpt"), "gpt-5.6-sol")
  assert.equal(canonicalHarnessModelId(devinProfile, "gpt-5-6-sol-medium"), "gpt-5.6-sol")
  assert.equal(canonicalHarnessModelId(devinProfile, "removed-model"), undefined)
  assert.deepEqual(resolveHarnessTuning(devinProfile, { model: "removed-model", effort: "high" }), {
    model: undefined,
    effort: undefined,
    fast: undefined,
    options: undefined,
  })

  const noAdaptive = normalizeDevinModels({ families: devinFixture.families.slice(2) })
  assert.equal(noAdaptive.models.some((model) => model.id === "adaptive"), false)
  assert.equal(noAdaptive.defaultModel, undefined)
  const reportedDefault = normalizeDevinModels({
    default_model: "gpt-5-6-sol-high",
    families: devinFixture.families.slice(2),
  })
  assert.equal(reportedDefault.defaultModel, "gpt-5.6-sol")
}

function assertGenericProfile(profile: HarnessProfile): void {
  assert(profile.models.length > 0, `${profile.id} reported no models`)
  assert.equal(new Set(profile.models.map((model) => model.id)).size, profile.models.length)
  if (profile.defaultModel) {
    assert(canonicalHarnessModelId(profile, profile.defaultModel), `${profile.id} default is not canonical`)
  }
  if (profile.configuredModel) {
    assert(canonicalHarnessModelId(profile, profile.configuredModel), `${profile.id} configured model is not canonical`)
  }
}

function assertLiveProfile(profile: HarnessProfile): void {
  assertGenericProfile(profile)
  if (profile.id === "claude") {
    assert(profile.models.every((model) => model.launchId))
    assert(profile.models.every((model) => model.id.length > 0 && model.label.length > 0))
  }
  if (profile.id === "codex") {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      const model = profile.models.find((entry) => entry.id === id)
      assert(model, `Codex did not report ${id}`)
      assert.equal(option(model, "serviceTier")?.kind, "select")
    }
  }
  if (profile.id === "cursor") {
    assert(profile.models.every((model) => !model.id.includes("[")))
    assert(profile.models.flatMap((model) => model.options).every((entry) =>
      entry.kind !== "select" || entry.values.every((value) => value.value === `${value.value}`)
    ))
    assert.equal(profile.defaultModel, "auto-smart")
    if (profile.configuredModel) assert.notEqual(profile.configuredModel, profile.defaultModel)
  }
  if (profile.id === "grok") {
    assert(profile.models.every((model) => !model.id.includes("[")))
    assert(profile.models.every((model) => option(model, "effort")?.kind === "select"))
  }
  if (profile.id === "devin") {
    assert.equal(profile.defaultModel, undefined)
    assert(profile.models.filter((model) => model.id === "adaptive").length <= 1)
    const variantIds = profile.models.flatMap((model) => model.variants?.map((variant) => variant.id) ?? [])
    assert.equal(new Set(variantIds).size, variantIds.length)
    const current = profile.models.find((model) => model.id === "gpt-5.6-sol")
    if (current) {
      assert(current.variants?.every((variant) => variant.contextWindow && variant.maxOutputTokens))
    }
  }
}

assertFixtureProfiles()
const live = await harnessProfiles()
const available = live.filter((profile) => profile.available)
for (const profile of available) assertLiveProfile(profile)
console.log(`Harness model checks passed: fixtures + ${available.length} installed profiles`)
