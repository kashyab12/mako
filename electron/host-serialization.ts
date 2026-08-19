import type {
  AgentSession,
  SessionEntry,
  SessionTreeNode,
} from "@earendil-works/pi-coding-agent"
import {
  THINKING_LEVELS,
  type Block,
  type ChatMessage,
  type ChatRole,
  type ModelInfo,
  type ThinkingLevel,
  type TreeNode,
} from "./shared.js"

/* ------------------------------------------------------------------ */
/* serialization                                                       */
/* ------------------------------------------------------------------ */

type RuntimeMessage = AgentSession["messages"][number]
type RuntimeContentMessage = Extract<
  RuntimeMessage,
  { role: "user" | "assistant" | "toolResult" | "custom" }
>
type RuntimeContent = RuntimeContentMessage["content"]
type RuntimeModel = NonNullable<AgentSession["model"]>

interface EntryPreview {
  preview: string
  role?: ChatRole
}

/** Project engine-owned content blocks onto the renderer wire contract. */
function blocksFrom(content: RuntimeContent): Block[] {
  if (!Array.isArray(content)) {
    return content ? [{ type: "text", text: content }] : []
  }
  const blocks: Block[] = []
  for (const part of content) {
    switch (part.type) {
      case "thinking":
        blocks.push({ type: "thinking", thinking: part.thinking })
        break
      case "toolCall":
        blocks.push({
          type: "toolCall",
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        })
        break
      case "image":
        blocks.push({ type: "image", mimeType: part.mimeType })
        break
      case "text":
        blocks.push({ type: "text", text: part.text })
        break
    }
  }
  return blocks
}

export function serializeMessage(message: RuntimeMessage, id: string): ChatMessage {
  switch (message.role) {
    case "toolResult":
      return {
        id,
        role: "tool",
        blocks: blocksFrom(message.content),
        timestamp: message.timestamp,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        isError: message.isError,
      }
    case "assistant":
      return {
        id,
        role: "assistant",
        blocks: blocksFrom(message.content),
        timestamp: message.timestamp,
        model: message.model,
        provider: message.provider,
        error: message.errorMessage,
      }
    case "user":
      return {
        id,
        role: "user",
        blocks: blocksFrom(message.content),
        timestamp: message.timestamp,
      }
    case "custom":
      return {
        id,
        role: "system",
        blocks: blocksFrom(message.content),
        timestamp: message.timestamp,
      }
    default:
      return { id, role: "system", blocks: [], timestamp: message.timestamp }
  }
}

function entryPreview(entry: SessionEntry): EntryPreview {
  if (entry.type === "message") {
    const message = serializeMessage(entry.message, entry.id)
    const preview = message.blocks
      .map((block) => block.text ?? block.thinking ?? (block.name ? `→ ${block.name}` : ""))
      .join(" ")
    return { preview: preview.replace(/\s+/g, " ").trim().slice(0, 200), role: message.role }
  }
  if (entry.type === "compaction") return { preview: `Compacted · ${entry.summary.slice(0, 140)}` }
  if (entry.type === "branch_summary") return { preview: `Branch · ${entry.summary.slice(0, 140)}` }
  if (entry.type === "model_change") return { preview: `${entry.provider}/${entry.modelId}` }
  if (entry.type === "thinking_level_change") return { preview: `Thinking · ${entry.thinkingLevel}` }
  if (entry.type === "session_info") return { preview: entry.name ? entry.name : "Session info" }
  return { preview: entry.type }
}

/**
 * Flatten the engine-owned tree and mark the root→leaf path so the UI can dim abandoned
 * branches. The output is a flat list: see the note on `TreeNode` for why
 * nesting is not an option here.
 */
export function serializeTree(nodes: SessionTreeNode[], leafId: string | null): TreeNode[] {
  const flat: TreeNode[] = []
  const byId = new Map<string, TreeNode>()

  const visit = (node: SessionTreeNode) => {
    const { preview, role } = entryPreview(node.entry)
    const serialized: TreeNode = {
      id: node.entry.id,
      parentId: node.entry.parentId,
      type: node.entry.type,
      label: node.label,
      timestamp: node.entry.timestamp,
      preview,
      role,
      onPath: false,
      childIds: node.children.map((child) => child.entry.id),
    }
    flat.push(serialized)
    byId.set(serialized.id, serialized)
    for (const child of node.children) visit(child)
  }
  for (const root of nodes) visit(root)

  // Walk up from the leaf rather than down from the roots: the path is one
  // chain, so this is linear instead of a full traversal.
  let cursor = leafId
  const guard = new Set<string>()
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor)
    const node = byId.get(cursor)
    if (!node) break
    node.onPath = true
    cursor = node.parentId
  }

  return flat
}

export function thinkingLevelsFor(model: RuntimeModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"]
  const map = model.thinkingLevelMap
  if (!map) return [...THINKING_LEVELS]
  return THINKING_LEVELS.filter((level) => level === "off" || map[level] !== null)
}

export function toModelInfo(model: RuntimeModel): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevels: thinkingLevelsFor(model),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
  }
}
