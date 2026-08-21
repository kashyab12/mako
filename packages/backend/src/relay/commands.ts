import type { RelayHarness, RelayJobPayload } from "./types"

interface ThreadSelection {
  harness: RelayHarness
  model?: string
  threadPath: string
}

export type SlackRelayCommand =
  | { kind: "enqueue"; payload: RelayJobPayload }
  | { kind: "harness"; harness: RelayHarness }
  | { kind: "help" }
  | { kind: "model"; model: string }
  | { kind: "status" }

function harness(value: string | undefined): RelayHarness | undefined {
  if (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "grok"
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
  if (normalized === "harness") {
    const selected = harness(parts[0]?.toLowerCase())
    return selected ? { kind: "harness", harness: selected } : { kind: "help" }
  }
  if (normalized === "model") {
    const model = parts.join(" ").trim()
    return model ? { kind: "model", model } : { kind: "help" }
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
  "`new [claude|codex|cursor|grok] <message>` — start a local thread",
  "`resume <thread-id-or-path> <message>` — resume an existing local thread",
  "`harness <claude|codex|cursor|grok>` — switch this Slack thread’s harness",
  "`model <model-id>` — choose the model for this Slack thread",
  "`status` — show laptop and thread status",
].join("\n")
