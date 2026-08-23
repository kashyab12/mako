import type {
  AcpSessionState,
  HarnessProfile,
  SessionMeta,
  Thread,
  TokenStats,
  TurnUsage,
} from "@/lib/types"

export type ContextAccounting =
  | {
      kind: "exact"
      owner: "builtin"
      model?: string
      tokens: number | null
      window: number
      percent: number | null
      cost: number
      stats: TokenStats
    }
  | {
      kind: "reported-input"
      owner: "thread"
      harness: string
      model?: string
      lastInput: number | null
      window: number
      cost: number | null
      stats: TokenStats | null
    }
  | {
      kind: "unavailable"
      owner: "acp"
      harness: string
      model?: string
      window: number
    }

function modelWindow(
  profiles: Record<string, HarnessProfile>,
  harness: string,
  model: string | undefined
): number {
  if (!model) return 0
  const found = profiles[harness]?.models.find(
    (candidate) =>
      candidate.id === model ||
      candidate.launchId === model ||
      candidate.label === model ||
      candidate.aliases?.includes(model)
  )
  return found?.contextWindow ?? 0
}

interface AggregatedUsage {
  last: TurnUsage | null
  cost: number | null
  stats: TokenStats | null
}

function aggregateUsage(entries: Thread["entries"]): AggregatedUsage {
  let last: TurnUsage | null = null
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let hasTokens = false
  let hasCost = false

  for (const entry of entries) {
    if (entry.kind !== "assistant" || !entry.usage) continue
    last = entry.usage
    input += entry.usage.input ?? 0
    output += entry.usage.output ?? 0
    cacheRead += entry.usage.cacheRead ?? 0
    cacheWrite += entry.usage.cacheWrite ?? 0
    hasTokens ||=
      entry.usage.input !== undefined ||
      entry.usage.output !== undefined ||
      entry.usage.cacheRead !== undefined ||
      entry.usage.cacheWrite !== undefined
    if (entry.usage.costUsd !== undefined) {
      cost += entry.usage.costUsd
      hasCost = true
    }
  }

  return {
    last,
    cost: hasCost ? cost : null,
    stats: hasTokens
      ? {
          input,
          output,
          cacheRead,
          cacheWrite,
          total: input + output + cacheRead + cacheWrite,
        }
      : null,
  }
}

export function contextAccounting({
  meta,
  viewing,
  acpSession,
  acpStarting,
  composerHarness,
  profiles,
}: {
  meta?: SessionMeta
  viewing: Thread | null
  acpSession: AcpSessionState | null
  acpStarting: boolean
  composerHarness: string
  profiles: Record<string, HarnessProfile>
}): ContextAccounting {
  if (acpSession || acpStarting) {
    const harness = acpSession?.harness ?? composerHarness
    const model = profiles[harness]?.configuredModel
    return {
      kind: "unavailable",
      owner: "acp",
      harness,
      model,
      window: modelWindow(profiles, harness, model),
    }
  }

  if (viewing) {
    const usage = aggregateUsage(viewing.entries)
    const latestModel = [...viewing.entries]
      .reverse()
      .find(
        (
          entry
        ): entry is Extract<Thread["entries"][number], { kind: "assistant" }> =>
          entry.kind === "assistant" && Boolean(entry.model)
      )
    const model = latestModel?.model ?? viewing.ref.model
    return {
      kind: "reported-input",
      owner: "thread",
      harness: viewing.ref.harness,
      model,
      lastInput: usage.last?.input ?? null,
      window: modelWindow(profiles, viewing.ref.harness, model),
      cost: usage.cost,
      stats: usage.stats,
    }
  }

  return {
    kind: "exact",
    owner: "builtin",
    model: meta?.model?.name,
    tokens: meta?.context?.tokens ?? null,
    window: meta?.context?.contextWindow ?? meta?.model?.contextWindow ?? 0,
    percent: meta?.context?.percent ?? null,
    cost: meta?.cost ?? 0,
    stats: meta?.tokens ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  }
}
