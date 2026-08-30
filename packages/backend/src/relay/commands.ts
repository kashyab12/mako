import {
  RelayHarnessSchema,
  type RelayHarness,
  type RelayJobPayload,
  type RemoteAttachment,
} from "./types"

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
  | { kind: "interrupt"; payload: RelayJobPayload }
  | { kind: "status" }
  | { kind: "stop" }

function harness(value: string | undefined): RelayHarness | undefined {
  const parsed = RelayHarnessSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function promptPayload({
  attachments,
  mapping,
  origin,
  text,
}: {
  attachments: RemoteAttachment[]
  mapping: ThreadSelection | null
  origin: RelayJobPayload["origin"]
  text: string
}): RelayJobPayload {
  return mapping
    ? {
        kind: "resume",
        attachments,
        selection: {
          effort: mapping.effort,
          fast: mapping.fast,
          harness: mapping.harness,
          model: mapping.model,
        },
        origin,
        text,
        threadPath: mapping.threadPath,
      }
    : {
        kind: "new",
        forceNew: false,
        attachments,
        selection: {},
        origin,
        text,
      }
}

export function parseSlackRelayCommand({
  attachments = [],
  mapping,
  origin,
  text,
}: {
  attachments?: RemoteAttachment[]
  mapping: ThreadSelection | null
  origin: RelayJobPayload["origin"]
  text: string
}): SlackRelayCommand {
  const trimmed = text.trim()
  const [command, ...parts] = trimmed.split(/\s+/)
  const normalized = command?.toLowerCase()

  if (normalized === "help") return { kind: "help" }
  if (normalized === "status") return { kind: "status" }
  if (normalized === "stop") return { kind: "stop" }
  if (normalized === "select") {
    const threadPath = parts.join(" ").trim()
    if (!threadPath) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "configure",
        origin,
        selection: {
          effort: mapping?.effort,
          fast: mapping?.fast,
          harness: mapping?.harness,
          model: mapping?.model,
        },
        threadPath,
      },
    }
  }
  if (normalized === "queue" || normalized === "steer") {
    const prompt = parts.join(" ").trim()
    if (!prompt && attachments.length === 0) return { kind: "help" }
    return {
      kind: normalized === "steer" ? "interrupt" : "enqueue",
      payload: promptPayload({ attachments, mapping, origin, text: prompt }),
    }
  }
  if (normalized === "reasoning") {
    const effort = parts.join(" ").trim()
    if (!mapping || !effort) return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "configure",
        selection: { ...mapping, effort },
        origin,
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
        origin,
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
        origin,
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
        origin,
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
        origin,
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
        origin,
      },
    }
  }
  if (normalized === "resume") {
    const [query, ...prompt] = parts
    if (!query || (prompt.length === 0 && attachments.length === 0))
      return { kind: "help" }
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
        attachments,
        origin,
        text: prompt.join(" "),
      },
    }
  }
  if (normalized === "new") {
    const explicitHarness = harness(parts[0]?.toLowerCase())
    const prompt = explicitHarness ? parts.slice(1) : parts
    if (prompt.length === 0 && attachments.length === 0)
      return { kind: "help" }
    return {
      kind: "enqueue",
      payload: {
        kind: "new",
        forceNew: true,
        selection: {
          effort: mapping?.effort,
          fast: mapping?.fast,
          harness: explicitHarness ?? mapping?.harness,
          model: mapping?.model,
        },
        attachments,
        origin,
        text: prompt.join(" "),
      },
    }
  }
  return {
    kind: "enqueue",
    payload: promptPayload({ attachments, mapping, origin, text: trimmed }),
  }
}

export const SlackRelayHelp = [
  "*Mako commands*",
  "`new [claude|codex|cursor|grok|devin|opencode] <message>` — start a local thread",
  "`threads [search]` — find local threads and their resume IDs",
  "`resume <thread-id-or-path> <message>` — resume an existing local thread",
  "`queue <message>` — send after the current turn finishes",
  "`steer <message>` — stop the current turn and send this next",
  "`stop` — stop the active local turn",
  "`harness <claude|codex|cursor|grok|devin|opencode>` — switch this Slack thread’s harness",
  "`models [harness]` — list live models and controls",
  "`model <model-id>` — choose the model for this Slack thread",
  "`reasoning <level>` — set provider-native reasoning effort",
  "`fast <on|off>` — switch provider-native fast mode",
  "`status` — show laptop, thread, harness, model, and tuning",
].join("\n")
