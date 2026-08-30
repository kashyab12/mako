import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk"
import { normalizeAcpOptions } from "./harnesses.js"
import type { AcpSessionState, AcpUpdate, HostEvent } from "./shared.js"

interface AcpToolOutputBoundary {
  value: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call_update" }
  >["rawOutput"]
}

/* ------------------------------------------------------------ translation */

/**
 * ACP updates, reduced to what the panel renders. Chunks stay chunks — the
 * renderer appends them — and tool calls carry their id so later updates
 * find the block they belong to.
 */
export function forward<LiveSession extends { id: string }>(
  live: LiveSession,
  notification: SessionNotification,
  emit: (event: HostEvent) => void,
  updateState: (
    live: LiveSession,
    patch: Partial<AcpSessionState>
  ) => void
): void {
  const raw = notification.update
  let update: AcpUpdate
  switch (raw.sessionUpdate) {
    case "user_message_chunk":
      // Replayed history (session/load streams the past back). Live user
      // turns are emitted by acpPrompt itself and never arrive this way.
      update = { kind: "user", text: contentText(raw.content) }
      break
    case "agent_message_chunk":
      update = { kind: "text", text: contentText(raw.content) }
      break
    case "agent_thought_chunk":
      update = { kind: "thinking", text: contentText(raw.content) }
      break
    case "tool_call":
      update = {
        kind: "tool",
        id: raw.toolCallId,
        title: raw.title ?? "tool",
        toolKind: raw.kind,
        status: raw.status ?? "pending",
        input:
          raw.rawInput === undefined
            ? undefined
            : JSON.stringify(raw.rawInput, null, 2),
      }
      break
    case "tool_call_update":
      update = {
        kind: "tool-update",
        id: raw.toolCallId,
        title: raw.title ?? undefined,
        status: raw.status ?? undefined,
        input:
          raw.rawInput === undefined
            ? undefined
            : JSON.stringify(raw.rawInput, null, 2),
        output: parseAcpToolOutput({ value: raw.rawOutput }),
      }
      break
    case "plan":
      update = {
        kind: "plan",
        entries: (raw.entries ?? []).map((entry) => ({
          content: entry.content,
          status: entry.status,
        })),
      }
      break
    case "current_mode_update":
      updateState(live, { currentMode: raw.currentModeId })
      return
    case "config_option_update":
      updateState(live, {
        configOptions: normalizeAcpOptions(raw.configOptions),
      })
      return
    default:
      return // Command lists and the rest are not rendered yet.
  }
  if ((update.kind !== "text" && update.kind !== "user") || update.text) {
    emit({ type: "acp-update", id: live.id, update })
  }
}

function parseAcpToolOutput(
  boundary: AcpToolOutputBoundary
): string | undefined {
  const { value } = boundary
  if (value === undefined) return undefined
  if (Object.prototype.toString.call(value) === "[object String]") {
    return String(value).slice(0, 256_000)
  }
  return JSON.stringify(value, null, 2).slice(0, 256_000)
}

function contentText(content: ContentBlock): string {
  return content.type === "text" ? content.text : ""
}
