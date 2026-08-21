export interface UsageTokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  longContext?: {
    threshold: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

const SONNET_LONG_CONTEXT = {
  threshold: 200_000,
  input: 6,
  output: 22.5,
  cacheRead: 0.6,
  cacheWrite: 7.5,
}

/** Standard API prices in USD per million tokens. */
const CLAUDE_PRICES = new Map<string, ModelPrice>([
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-sonnet-5", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-opus-4-current", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-legacy", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-opus-3", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [
    "claude-sonnet-4",
    {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      longContext: SONNET_LONG_CONTEXT,
    },
  ],
  ["claude-sonnet-3", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-4", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ["claude-haiku-3.5", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ["claude-haiku-3", { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 }],
])

const OPENAI_PRICES = new Map<string, ModelPrice>([
  ["gpt-4.1", { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],
  ["gpt-4o", { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }],
  ["o3", { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],
  ["o4-mini", { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 }],
  ["codex-mini", { input: 1.5, output: 6, cacheRead: 0.375, cacheWrite: 1.5 }],
  ["gpt-5", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
  ["gpt-5.1", { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
  ["gpt-5.2", { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 }],
  ["gpt-5.3", { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 }],
  ["gpt-5.4", { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 }],
  ["gpt-5.4-mini", { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 }],
  ["gpt-5.4-nano", { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 }],
  ["gpt-5.4-pro", { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 }],
  ["gpt-5.5", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 }],
  [
    "gpt-5.6-sol",
    {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      longContext: {
        threshold: 272_000,
        input: 10,
        output: 45,
        cacheRead: 1,
        cacheWrite: 12.5,
      },
    },
  ],
  [
    "gpt-5.6-terra",
    {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      longContext: {
        threshold: 272_000,
        input: 4,
        output: 18,
        cacheRead: 0.4,
        cacheWrite: 5,
      },
    },
  ],
  [
    "gpt-5.6-luna",
    {
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
      longContext: {
        threshold: 272_000,
        input: 0.4,
        output: 1.8,
        cacheRead: 0.04,
        cacheWrite: 0.5,
      },
    },
  ],
])

export function estimateUsageCost(
  model: string | undefined,
  usage: UsageTokenCounts
): number | null {
  const key = pricingKey(model)
  if (key === null) return null
  const price = CLAUDE_PRICES.get(key) ?? OPENAI_PRICES.get(key)
  if (!price) return null

  const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
  const active =
    price.longContext && contextTokens > price.longContext.threshold
      ? price.longContext
      : price
  return (
    (usage.input * active.input +
      usage.output * active.output +
      usage.cacheRead * active.cacheRead +
      usage.cacheWrite * active.cacheWrite) /
    1_000_000
  )
}

function pricingKey(model: string | undefined): string | null {
  if (!model) return null
  const value = model
    .toLowerCase()
    .trim()
    .replace(/^anthropic[/:]/, "")
    .replace(/\./g, "-")
    .replace(/\((minimal|low|medium|high|xhigh|auto|none)\)$/, "")
    .replace(/-(minimal|low|medium|high|xhigh|auto|none)$/, "")

  if (value.includes("fable-5")) return "claude-fable-5"
  if (value.includes("opus-5")) return "claude-opus-5"
  if (value.includes("sonnet-5")) return "claude-sonnet-5"
  if (value.includes("opus-4-1")) return "claude-opus-4-legacy"
  if (/opus-4(?:$|-thinking$|-20\d{6}(?:-thinking)?$|@20\d{6}$)/.test(value))
    return "claude-opus-4-legacy"
  if (value.includes("opus-4")) return "claude-opus-4-current"
  if (value.includes("opus-3") || value.includes("3-opus"))
    return "claude-opus-3"
  if (value.includes("sonnet-4")) return "claude-sonnet-4"
  if (
    value.includes("sonnet-3-7") ||
    value.includes("sonnet-3-5") ||
    value.includes("3-7-sonnet") ||
    value.includes("3-5-sonnet")
  )
    return "claude-sonnet-3"
  if (value.includes("haiku-4-5")) return "claude-haiku-4"
  if (value.includes("haiku-3-5") || value.includes("3-5-haiku"))
    return "claude-haiku-3.5"
  if (value.includes("haiku-3") || value.includes("3-haiku"))
    return "claude-haiku-3"

  if (value.startsWith("gpt-4-1")) return "gpt-4.1"
  if (value.startsWith("gpt-4o")) return "gpt-4o"
  if (value === "o3" || value.startsWith("o3-")) return "o3"
  if (value.startsWith("o4-mini")) return "o4-mini"
  if (value.startsWith("codex-mini")) return "codex-mini"
  if (value.startsWith("gpt-5-6-terra")) return "gpt-5.6-terra"
  if (value.startsWith("gpt-5-6-luna")) return "gpt-5.6-luna"
  if (value === "gpt-5-6" || value.startsWith("gpt-5-6-sol"))
    return "gpt-5.6-sol"
  if (value.startsWith("gpt-5-5")) return "gpt-5.5"
  if (value.startsWith("gpt-5-4-mini")) return "gpt-5.4-mini"
  if (value.startsWith("gpt-5-4-nano")) return "gpt-5.4-nano"
  if (value.startsWith("gpt-5-4-pro")) return "gpt-5.4-pro"
  if (value.startsWith("gpt-5-4")) return "gpt-5.4"
  if (value.startsWith("gpt-5-3")) return "gpt-5.3"
  if (value.startsWith("gpt-5-2")) return "gpt-5.2"
  if (value.startsWith("gpt-5-1")) return "gpt-5.1"
  if (value === "gpt-5" || value.startsWith("gpt-5-codex")) return "gpt-5"
  return null
}
