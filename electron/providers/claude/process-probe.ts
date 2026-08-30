import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { resolveExecutable } from "../../executable.js"
import { probeOpenFiles } from "../open-files-probe.js"
import { processIdentityMatches } from "../process-liveness.js"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../process-probe.js"

const run = promisify(execFile)
const MAX_REGISTRY_ENTRY_BYTES = 64 * 1024
const ClaudeAgentSchema = z.object({
  id: z.string().min(1).max(160).optional(),
  pid: z.number().int().positive().optional(),
  sessionId: z.string().min(1).max(160).optional(),
  startedAt: z.union([z.number(), z.string()]).optional(),
  state: z.string().max(80).optional(),
  status: z.string().max(80).optional(),
  waitingFor: z.string().max(256).optional(),
})
const ClaudeAgentsSchema = z.array(ClaudeAgentSchema).max(1_000)

function activity(agent: z.infer<typeof ClaudeAgentSchema>) {
  const waiting =
    agent.state === "blocked" ||
    agent.status === "waiting" ||
    agent.status === "needs_input" ||
    agent.status === "needs-input"
  return {
    nativeId: agent.sessionId ?? agent.id,
    status: waiting ? "needs-input" : "active",
    detail: waiting ? agent.waitingFor : undefined,
  } satisfies ProviderActivitySession
}

export function parseClaudeActiveSessions<Value>(
  value: Value
): ProviderActivitySession[] {
  return ClaudeAgentsSchema.parse(value).flatMap((agent) =>
    agent.sessionId || agent.id ? [activity(agent)] : []
  )
}

async function registrySessions(
  home: string,
  signal: AbortSignal
): Promise<ProviderActivitySession[] | null> {
  const root = join(home, ".claude", "sessions")
  const files = await readdir(root).catch(() => null)
  if (!files) return null
  const sessions: ProviderActivitySession[] = []
  for (const file of files.slice(0, 1_000)) {
    if (signal.aborted) return null
    if (!file.endsWith(".json")) continue
    const path = join(root, file)
    const info = await stat(path).catch(() => null)
    if (!info || info.size > MAX_REGISTRY_ENTRY_BYTES) continue
    try {
      const agent = ClaudeAgentSchema.parse(
        JSON.parse(await readFile(path, { encoding: "utf8", signal }))
      )
      if (
        agent.pid &&
        agent.sessionId &&
        (await processIdentityMatches({
          pid: agent.pid,
          startedAt: agent.startedAt,
          signal,
        }))
      )
        sessions.push(activity(agent))
    } catch {
      continue
    }
  }
  return sessions
}

export function claudeProcessProbeFor(
  home = homedir()
): ProviderProcessProbe {
  return {
    provider: "claude",
    pollIntervalMs: 5_000,
    staleAfterMs: 15_000,
    async probe(signal) {
      const registered = await registrySessions(home, signal)
      if (registered) return { kind: "available", sessions: registered }
      const running = await probeOpenFiles({
        processNames: ["claude"],
        signal,
        accept: () => false,
      })
      if (running.kind === "available" && !running.processFound)
        return { kind: "available", sessions: [] }
      if (running.kind === "unavailable" && process.platform !== "win32")
        return running
      const command = resolveExecutable("claude")
      if (!command) return { kind: "unavailable", reason: "unsupported" }
      try {
        const { stdout } = await run(command, ["agents", "--json"], {
          maxBuffer: 8 * 1024 * 1024,
          timeout: 4_000,
          signal,
        })
        return {
          kind: "available",
          sessions: parseClaudeActiveSessions(JSON.parse(stdout)),
        }
      } catch {
        return {
          kind: "unavailable",
          reason: signal.aborted ? "timeout" : "failed",
        }
      }
    },
  }
}

export const claudeProcessProbe = claudeProcessProbeFor()
