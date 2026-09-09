import type { AcpBlock } from "@/lib/acp-blocks"
import { liveToolName } from "@/lib/tools"

export type AgentActivityKind = "working" | "connecting" | "reasoning" | "searching" | "executing" | "editing" | "responding" | "waiting" | "failed" | "complete" | "idle"

export interface AgentActivity {
  kind: AgentActivityKind
  label: string
}

export function toolActivity(name: string): AgentActivityKind {
  const tool = name.toLowerCase().split(".").at(-1)
  if (["edit", "write", "apply_patch", "multiedit", "delete", "move", "write_file"].includes(tool ?? "")) return "editing"
  if (["grep", "glob", "rg", "find", "read", "readfile", "read_file", "websearch", "web_search", "webfetch", "ls"].includes(tool ?? "")) return "searching"
  return "executing"
}

export function agentActivity({ blocks, waiting, connecting, preparing }: { blocks: readonly AcpBlock[]; waiting: boolean; connecting: boolean; preparing: boolean }): AgentActivity {
  if (waiting) return { kind: "waiting", label: "Waiting for your approval" }
  if (connecting) return { kind: "connecting", label: "Connecting" }
  if (preparing) return { kind: "connecting", label: "Sending" }
  const tool = blocks.findLast((block) => block.type === "tool" && block.status === "pending")
  if (tool?.type === "tool") return { kind: toolActivity(liveToolName(tool.toolKind, tool.title)), label: tool.title }
  const last = blocks.at(-1)
  if (last?.type === "thinking") return { kind: "reasoning", label: "Reasoning" }
  if (last?.type === "text") return { kind: "responding", label: "Responding" }
  return { kind: "working", label: "Working" }
}
