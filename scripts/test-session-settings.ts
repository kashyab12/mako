import { forward } from "../electron/acp-notifications.ts"
import { normalizeCodexModels } from "@mako/sessions/model-catalog"
import assert from "node:assert/strict"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { applyAcpSettings } from "../electron/acp-config.ts"
import { codexWireSettings } from "../electron/providers/codex/settings.ts"
import { claudeSettingsFromLayers } from "../electron/providers/claude/settings.ts"
import { cursorNativeRunner } from "../electron/providers/cursor/native-runner.ts"

const model: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "a",
  options: [
    { value: "a", name: "A" },
    { value: "b", name: "B" },
  ],
}
const effort: SessionConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning",
  category: "thought_level",
  type: "select",
  currentValue: "low",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
}
const order: string[] = []
const applied = await applyAcpSettings({
  settings: { model: "b", options: { effort: "high" } },
  observed: { model: "a", options: { effort: "low" } },
  options: [model, effort],
  async setOption(option, value) {
    order.push(`${option.id}:${value}`)
    return [
      option.id === "model"
        ? { ...model, currentValue: String(value) }
        : { ...model, currentValue: "b" },
      option.id === effort.id
        ? { ...effort, currentValue: String(value) }
        : effort,
    ]
  },
  async setModel() {
    assert.fail("model must use its reported config option")
  },
})
assert.deepEqual(order, ["model:b", "reasoning_effort:high"])
assert.deepEqual(applied.settings, { model: "b", options: { effort: "high" } })
await assert.rejects(
  applyAcpSettings({
    settings: { options: { fast: false } },
    observed: { options: { fast: true } },
    options: [],
    async setOption() {
      assert.fail()
    },
    async setModel() {
      assert.fail()
    },
  }),
  /cannot change fast/
)
await assert.rejects(
  applyAcpSettings({
    settings: { options: { effort: "high" } },
    observed: {},
    options: [effort],
    async setOption() {
      throw new Error("provider rejected setting")
    },
    async setModel() {
      assert.fail()
    },
  }),
  /provider rejected/
)
assert.deepEqual(
  codexWireSettings({ options: { serviceTier: "default", effort: "high" } }),
  { model: undefined, effort: "high", serviceTier: "default" }
)
assert.equal(codexWireSettings().serviceTier, undefined)
assert.deepEqual(claudeSettingsFromLayers([], {}), { options: {} })
assert.deepEqual(
  claudeSettingsFromLayers(
    [{ effortLevel: "low", fastMode: true }, { effortLevel: "high" }],
    {}
  ),
  { options: { effort: "high", fast: true } }
)
assert.equal(
  claudeSettingsFromLayers(
    [{ fastMode: true, fastModePerSessionOptIn: true }],
    {}
  ).options?.fast,
  false
)
assert.equal(
  claudeSettingsFromLayers([{ effortLevel: "low" }], {
    CLAUDE_CODE_EFFORT_LEVEL: "high",
  }).options?.effort,
  "high"
)
assert.equal(
  cursorNativeRunner
    .resume("id", "continue", {
      model: "opus[effort=high,fast=true]",
      options: { effort: "low", fast: false },
    })
    .args.at(-1),
  "opus[effort=low,fast=false]"
)
console.log(
  "Session settings transports: sequential ACP acknowledgement and rejection, Codex reset, Claude precedence, and Cursor parameters passed"
)

const dualCatalog = normalizeCodexModels({
  data: [
    {
      model: "test",
      serviceTiers: [
        { id: "priority", name: "Fast", description: "Provider detail" },
      ],
      additionalSpeedTiers: ["fast"],
    },
  ],
})
const speed = dualCatalog.models[0]!.options.find(
  (option) => option.id === "serviceTier"
)
assert.equal(speed?.kind, "select")
if (speed?.kind === "select")
  assert.deepEqual(speed.values, [
    { value: "default", label: "Standard" },
    {
      value: "priority",
      label: "Fast",
      description: "Provider detail",
      aliases: ["fast"],
    },
  ])
assert.equal(
  codexWireSettings({ options: { serviceTier: "fast" } }).serviceTier,
  "priority"
)

const observedChanges: unknown[] = []
forward(
  { id: "live" },
  {
    sessionId: "session",
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [{ ...effort, currentValue: "high" }],
    },
  },
  () => assert.fail("config is a state update"),
  (_live, patch) => observedChanges.push(patch.settings),
  { model: "a", options: { effort: "low" } }
)
assert.deepEqual(observedChanges, [{ model: "a", options: { effort: "high" } }])
