import type { Block, PiMessage } from "@/lib/types"
import type { ToolCall } from "@/extend/slots"

/**
 * Fold `tool` messages back into the assistant turn that called them. Pi's
 * message log keeps results as separate entries; the transcript reads far
 * better when a call and its result are one row.
 */
export function foldTools(messages: PiMessage[]): PiMessage[] {
  const output: PiMessage[] = []
  for (const message of messages) {
    const previous = output.at(-1)
    if (message.role === "tool" && previous?.role === "assistant") {
      output[output.length - 1] = {
        ...previous,
        blocks: [
          ...previous.blocks,
          {
            type: "toolResult",
            id: message.toolCallId,
            name: message.toolName,
            isError: message.isError,
            text: message.blocks
              .map((block) => block.text ?? "")
              .filter(Boolean)
              .join("\n"),
          },
        ],
      }
      continue
    }
    output.push(message)
  }
  return output
}

/** Pair `toolCall` blocks with their `toolResult` blocks, preserving order. */
export function pairTools(blocks: Block[]): ToolCall[] {
  const order: string[] = []
  const byId = new Map<string, ToolCall>()

  for (const block of blocks) {
    if (block.type === "toolCall") {
      const id = block.id || `${block.name}-${order.length}`
      order.push(id)
      byId.set(id, {
        id,
        name: block.name ?? "tool",
        arguments: block.arguments,
        pending: true,
      })
      continue
    }
    if (block.type !== "toolResult") continue
    const id = block.id || order.find((key) => byId.get(key)?.pending) || `result-${order.length}`
    const existing = byId.get(id)
    if (existing) {
      existing.result = block.text
      existing.isError = block.isError
      existing.pending = false
    } else {
      order.push(id)
      byId.set(id, {
        id,
        name: block.name ?? "tool",
        result: block.text,
        isError: block.isError,
        pending: false,
      })
    }
  }

  return order.map((id) => byId.get(id)!).filter(Boolean)
}

/** The one argument worth putting on a collapsed row. */
export function primaryArgument(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  const candidate =
    record.path ??
    record.file_path ??
    record.filePath ??
    record.command ??
    record.pattern ??
    record.query ??
    record.url ??
    record.directory
  return candidate == null ? "" : String(candidate)
}

export function argAt(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === "string" ? found : undefined
}

export function countLines(text?: string) {
  if (!text) return 0
  let lines = 1
  for (const char of text) if (char === "\n") lines += 1
  return lines
}

/** Normalize the edit tool's arguments: a list of edits, or the legacy pair. */
export function editsOf(call: ToolCall): Array<{ oldText: string; newText: string }> {
  const args = call.arguments as Record<string, unknown> | undefined
  if (!args) return []
  if (Array.isArray(args.edits)) {
    return (args.edits as Array<{ oldText?: string; newText?: string }>).map((edit) => ({
      oldText: edit.oldText ?? "",
      newText: edit.newText ?? "",
    }))
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return [{ oldText: args.oldText, newText: args.newText }]
  }
  return []
}
