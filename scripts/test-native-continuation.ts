import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  nativeCheckpoint,
  canResumeBinding,
} from "../electron/native-continuation.ts"
import type { ProviderBinding } from "../electron/contracts/conversation-control.ts"
import type { ProviderProcessProbe } from "../electron/providers/process-probe.ts"

const root = await mkdtemp(join(tmpdir(), "mako-checkpoint-"))
try {
  const path = join(root, "native.jsonl")
  await writeFile(path, "original history\n")
  const checkpoint = await nativeCheckpoint(path)
  assert.ok(checkpoint)
  const binding: ProviderBinding = {
    id: "fixture",
    provider: "fixture",
    nativeId: "native-fixture",
    path,
    checkpoint,
    coveredBlocks: 3,
    includesBase: true,
  }
  const idle: ProviderProcessProbe = {
    provider: "fixture",
    probe: async () => ({ kind: "available", sessions: [] }),
  }
  assert.equal(await canResumeBinding(binding, idle), true)
  assert.equal(await canResumeBinding(binding, undefined), false)
  assert.equal(
    await canResumeBinding(binding, {
      ...idle,
      probe: async () => ({ kind: "unavailable", reason: "failed" }),
    }),
    false
  )
  assert.equal(
    await canResumeBinding(binding, {
      ...idle,
      probe: async () => {
        throw new Error("probe failed")
      },
    }),
    false
  )
  for (const session of [{ nativeId: binding.nativeId }, { path }]) {
    assert.equal(
      await canResumeBinding(binding, {
        ...idle,
        probe: async () => ({
          kind: "available",
          sessions: [{ ...session, status: "active" }],
        }),
      }),
      false
    )
  }
  await writeFile(path, "modified history\n")
  assert.equal(await canResumeBinding(binding, idle), false)
  await rm(path)
  assert.equal(await canResumeBinding(binding, idle), false)
  assert.equal(await nativeCheckpoint(root), undefined)
  console.log(
    "Native continuation: unchanged file accepted; changed, missing, active, unavailable and failed probes denied"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
