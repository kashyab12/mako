// Run from the repository root with node --import tsx docs/audits/2026-09-07/harness-defaults/reproduce.mjs
// These assertions document existing defects, not desired regression behavior.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeCodexModels, normalizeDevinModels, resolveHarnessTuning } from '../../../../electron/harness-models.ts'
import { codexNativeRunner } from '../../../../electron/providers/codex/native-runner.ts'
import { ProviderProfileCache } from '../../../../electron/provider-profile-cache.ts'

const catalog = normalizeCodexModels({ data: [{
  model: 'sample-model', isDefault: true, defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
  additionalSpeedTiers: ['fast'],
}] })
assert.equal(catalog.models[0].options.some(option => option.id === 'serviceTier'), false)
console.log('REPRODUCED: additionalSpeedTiers alone produces no speed control')

assert.deepEqual(
  codexNativeRunner.fresh('example', { fast: true }),
  codexNativeRunner.fresh('example', { fast: false }),
)
console.log('REPRODUCED: native Codex fast=true and fast=false emit identical commands')

const devin = normalizeDevinModels({ families: [{
  slug: 'sample-family', family_label: 'Sample', is_default: true,
  variants: [
    { model_uid: 'sample-low', label: 'Low' },
    { model_uid: 'sample-high-fast', label: 'High Fast', is_default: true },
  ],
}] })
const profile = { id: 'devin', label: 'Devin', transport: 'acp', available: true, capabilities: [], ...devin }
assert.equal(resolveHarnessTuning(profile, { model: devin.defaultModel }).model, 'sample-low')
console.log('REPRODUCED: explicit Devin default variant resolves to the first, non-default variant')

const directory = await mkdtemp(join(tmpdir(), 'mako-defaults-audit-'))
try {
  const path = join(directory, 'cache.json')
  const cachedProfile = { ...profile, models: [{ id: 'sample', label: 'Sample', options: [{
    kind: 'select', id: 'effort', label: 'Reasoning',
    values: [{ value: 'high', label: 'High', default: true, description: 'Provider description' }],
  }] }] }
  await new ProviderProfileCache(path).put('sample', cachedProfile)
  const restored = await new ProviderProfileCache(path).get('sample')
  assert.deepEqual(restored.models[0].options[0].values[0], { value: 'high', label: 'High' })
  console.log('REPRODUCED: disk cache reload strips option default and description')
} finally {
  await rm(directory, { recursive: true, force: true })
}
