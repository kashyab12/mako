import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { processIdentityMatches } from "../process-liveness.js"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../process-probe.js"

const MAX_REGISTRY_BYTES = 1024 * 1024
const GrokActiveSessionSchema = z.object({
  session_id: z.string().min(1).max(160).optional(),
  sessionId: z.string().min(1).max(160).optional(),
  id: z.string().min(1).max(160).optional(),
  opened_at: z.union([z.number(), z.string()]).optional(),
  openedAt: z.union([z.number(), z.string()]).optional(),
  pid: z.number().int().positive(),
})
const GrokActiveSessionsSchema = z.array(GrokActiveSessionSchema).max(4_096)

export function parseGrokActiveSessions<Value>(
  value: Value,
  isAlive: (pid: number) => boolean
): ProviderActivitySession[] {
  return GrokActiveSessionsSchema.parse(value).flatMap((session) => {
    const nativeId = session.session_id ?? session.sessionId ?? session.id
    return nativeId && isAlive(session.pid)
      ? [{ nativeId, status: "active" } satisfies ProviderActivitySession]
      : []
  })
}

async function validatedSessions<Value>(
  value: Value,
  signal: AbortSignal
): Promise<ProviderActivitySession[]> {
  const active: ProviderActivitySession[] = []
  for (const session of GrokActiveSessionsSchema.parse(value)) {
    const nativeId = session.session_id ?? session.sessionId ?? session.id
    if (
      nativeId &&
      (await processIdentityMatches({
        pid: session.pid,
        startedAt: session.opened_at ?? session.openedAt,
        signal,
      }))
    )
      active.push({ nativeId, status: "active" })
  }
  return active
}

function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), ".grok")
}

export const grokProcessProbe: ProviderProcessProbe = {
  provider: "grok",
  pollIntervalMs: 3_000,
  staleAfterMs: 10_000,
  async probe(signal) {
    const path = join(grokHome(), "active_sessions.json")
    const info = await stat(path).catch(() => null)
    if (!info) return { kind: "available", sessions: [] }
    if (info.size > MAX_REGISTRY_BYTES)
      return { kind: "unavailable", reason: "failed" }
    try {
      return {
        kind: "available",
        sessions: await validatedSessions(
          JSON.parse(await readFile(path, { encoding: "utf8", signal })),
          signal
        ),
      }
    } catch {
      return { kind: "unavailable", reason: "failed" }
    }
  },
}
