import type { RelayHarness, RelayJobPayload } from "./types"

interface ThreadSelection {
  effort?: string
  fast?: boolean
  harness: RelayHarness
  model?: string
  threadPath: string
}

export type SlackRelayCommand =
  | { kind: "enqueue"; payload: RelayJobPayload }
  | { kind: "help" }
  | { kind: "status" }

function harness(value: string | undefined): RelayHarness | undefined {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "grok" ||
    value === "devin" ||
    value === "opencode"
  ) {
    return value
  }
  return undefined
}

export function parseSlackRelayCommand({
  mapping,
  slack,
  text,
}: {
  mapping: ThreadSelection | null
  slack: RelayJobPayload["slack"]
  text: string
}): SlackRelayCommand {
  const trimmed = text.trim()
  const [command, ...parts] = trimmed.split(/\s+/)
  const normalized = command?.toLowerCase()

  if (normalized === "help") return { kind: "help" }
  if (normalized === "status") return { kind: "status" }
  if (normalized === "reasoning") {
    const effort = parts.join(" ").trim()
    if (!mapping || !effort) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "configure",
        selection: { ...mapping, effort },
        slack,
        threadPath: mapping.threadPath,
      },
    }
  }
  if (normalized === "fast") {
    const value = parts[0]?.toLowerCase()
    const fast =
      value === "on" || value === "true" || value === "yes"
        ? true
        : value === "off" || value === "false" || value === "no"
          ? false
          : undefined
    if (!mapping || fast === undefined) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "configure",
        selection: { ...mapping, fast },
        slack,
        threadPath: mapping.threadPath,
      },
    }
  }
  if (normalized === "harness") {
    const selected = harness(parts[0]?.toLowerCase())
    if (!mapping || !selected) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "configure",
        selection: { ...mapping, harness: selected },
        slack,
        threadPath: mapping.threadPath,
      },
    }
  }
  if (normalized === "model") {
    const model = parts.join(" ").trim()
    if (!mapping || !model) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "configure",
        selection: { ...mapping, model },
        slack,
        threadPath: mapping.threadPath,
      },
    }
  }
  if (normalized === "threads") {
    const query = parts.join(" ").trim()
    return {
      kind: "enqueue",
      payload: {
        kind: "inspect-threads",
        query: query || undefined,
        selection: {
          harness: mapping?.harness,
        },
        slack,
      },
    }
  }
  if (normalized === "models") {
    const selected = harness(parts[0]?.toLowerCase()) ?? mapping?.harness
    return {
      kind: "enqueue",
      payload: {
        kind: "inspect-models",
        selection: { harness: selected },
        slack,
      },
    }
  }
  if (normalized === "resume") {
    const [query, ...prompt] = parts
    if (!query || prompt.length === 0) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "resume-query",
        query,
        selection: {
          effort: mapping?.effort,
          fast: mapping?.fast,
          harness: mapping?.harness,
          model: mapping?.model,
        },
        slack,
        text: prompt.join(" "),
      },
    }
  }
  if (normalized === "new") {
    const explicitHarness = harness(parts[0]?.toLowerCase())
    const prompt = explicitHarness ? parts.slice(1) : parts
    if (prompt.length === 0) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "new",
        selection: {
          effort: mapping?.effort,
          fast: mapping?.fast,
          harness: explicitHarness ?? mapping?.harness,
          model: mapping?.model,
        },
        slack,
        text: prompt.join(" "),
      },
    }
  }
  if (mapping) {
    return {
      kind: "enqueue",
      payload: {
        kind: "resume",
        selection: {
          effort: mapping.effort,
          fast: mapping.fast,
          harness: mapping.harness,
          model: mapping.model,
        },
        slack,
        text: trimmed,
        threadPath: mapping.threadPath,
      },
    }
  }
  return {
    kind: "enqueue",
    payload: {
      kind: "new",
      selection: {},
      slack,
      text: trimmed,
    },
  }
}

export const SlackRelayHelp = [
  "*Mako commands*",
  "`new [claude|codex|cursor|grok|devin|opencode] <message>` — start a local thread",
  "`threads [search]` — find local threads and their resume IDs",
  "`resume <thread-id-or-path> <message>` — resume an existing local thread",
  "`harness <claude|codex|cursor|grok|devin|opencode>` — switch this Slack thread’s harness",
  "`models [harness]` — list live models and controls",
  "`model <model-id>` — choose the model for this Slack thread",
  "`reasoning <level>` — set provider-native reasoning effort",
  "`fast <on|off>` — switch provider-native fast mode",
  "`status` — show laptop, thread, harness, model, and tuning",
].join("\n")
