import assert from "node:assert/strict"
import { resolveSessionSettings, resolveModelLaunch, SessionModelSchema } from "../dist/settings.js"

const models = [{ id: "a", label: "A", options: [
  { kind: "select", id: "effort", label: "Reasoning", role: "reasoning", current: "medium", values: [
    { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" },
  ] },
  { kind: "select", id: "tier", label: "Speed", role: "speed", values: [
    { value: "default", label: "Standard" }, { value: "fast", label: "Fast" },
  ] },
] }, { id: "b", label: "B", options: [] }]

const inherited = resolveSessionSettings({ models, context: "new" })
assert.equal(inherited.model.kind, "unknown")
assert.deepEqual(inherited.settings, {})

const configured = resolveSessionSettings({ models, context: "new", defaults: {
  model: "a", options: { effort: "high", tier: "fast" },
} })
assert.equal(configured.options.effort.source, "provider")
assert.equal(configured.settings.options.tier, "fast")

const existing = resolveSessionSettings({ models, context: "existing",
  session: { model: "a", options: { effort: "low", tier: "fast" } },
  preference: { source: "saved", settings: { model: "b" } },
  overrides: { options: { tier: "default" } },
})
assert.equal(existing.model.value, "a")
assert.equal(existing.settings.model, existing.model.value)
assert.equal(existing.settings.options.effort, "low")
assert.equal(existing.settings.options.tier, "default")
assert.equal(existing.options.tier.source, "override")

const unknownEffort = resolveSessionSettings({ models, context: "existing", session: { model: "a" } })
assert.equal(unknownEffort.options.effort.kind, "unknown")
assert.equal(unknownEffort.settings.options, undefined)

const switched = resolveSessionSettings({ models, context: "existing",
  session: { model: "a", options: { effort: "high" } }, overrides: { model: "b" },
})
assert.deepEqual(switched.settings, { model: "b" })

const invalid = resolveSessionSettings({ models, context: "new", overrides: { model: "a", options: { effort: "ultra" } } })
assert.equal(invalid.issues.length, 1)
assert.throws(() => resolveModelLaunch(models, invalid.settings), /not supported/)
assert.deepEqual(resolveModelLaunch(models, { model: "private-model" }), { model: "private-model" })

const family = [{ id: "family", label: "Family", launchId: "high-fast", options: [
  { kind: "select", id: "effort", label: "Reasoning", current: "high", values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
  { kind: "boolean", id: "fast", label: "Fast", current: true },
], variants: [
  { id: "low-standard", label: "Low", values: { effort: "low", fast: false } },
  { id: "high-fast", label: "High Fast", values: { effort: "high", fast: true } },
] }]
assert.equal(resolveModelLaunch(family, { model: "family" }).model, "high-fast")
assert.equal(resolveModelLaunch(family, { model: "low-standard" }).model, "low-standard")
assert.throws(() => resolveModelLaunch(family, { model: "family", options: { fast: false } }), /not available together/)
assert.deepEqual(SessionModelSchema.parse(models[0]), models[0])
console.log("Shared session settings: provenance, inheritance, explicit reset, model changes, and variants passed")
