import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import type { ProviderBinding } from "./contracts/conversation-control.js"
import type { ProviderProcessProbe } from "./providers/process-probe.js"

/** Streaming fingerprints cover the entire native record without retaining it in memory. */
export async function nativeCheckpoint(
  path: string
): Promise<string | undefined> {
  try {
    const before = await stat(path)
    if (!before.isFile()) return undefined
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    const after = await stat(path)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      return undefined
    return hash.digest("hex")
  } catch {
    return undefined
  }
}

export async function canResumeBinding(
  binding: ProviderBinding,
  probe: ProviderProcessProbe | undefined
): Promise<boolean> {
  if (!binding.nativeId || !binding.path || !binding.checkpoint) return false
  if (!probe) return false
  const activity = await probe
    .probe(AbortSignal.timeout(probe.timeoutMs ?? 6_000))
    .catch(() => ({ kind: "unavailable" as const }))
  if (
    activity.kind !== "available" ||
    activity.sessions.some(
      (session) =>
        session.nativeId === binding.nativeId || session.path === binding.path
    )
  )
    return false
  return (await nativeCheckpoint(binding.path)) === binding.checkpoint
}
