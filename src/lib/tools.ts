import type { Block, PiMessage } from "@/lib/types"
import type { ToolCall } from "@/extend/slots"

type ToolScalar = boolean | number | string | null
type ToolContent = ToolScalar | ToolArguments | ToolContent[]

interface ToolArguments {
  [key: string]: ToolContent | undefined
}

interface ToolEdit {
  oldText: string
  newText: string
}

function parseToolContent<Content>(value: Content): ToolContent | undefined {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return undefined
  }
  if (serialized === undefined) return undefined
  try {
    const content: ToolContent = JSON.parse(serialized)
    return content
  } catch {
    return undefined
  }
}

function isToolArguments(content: ToolContent | undefined): content is ToolArguments {
  return (
    content !== undefined &&
    content !== null &&
    !Array.isArray(content) &&
    Object.prototype.toString.call(content) === "[object Object]"
  )
}

function parseToolArguments<Content>(value: Content): ToolArguments | undefined {
  const content = parseToolContent(value)
  return isToolArguments(content) ? content : undefined
}

function stringContent(content: ToolContent | undefined): string | undefined {
  return Object.prototype.toString.call(content) === "[object String]"
    ? String(content)
    : undefined
}

function parseToolEdit(content: ToolContent): ToolEdit {
  const edit = isToolArguments(content) ? content : undefined
  return {
    oldText: stringContent(edit?.oldText) ?? "",
    newText: stringContent(edit?.newText) ?? "",
  }
}

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
export function primaryArgument<Content>(value: Content): string {
  const args = parseToolArguments(value)
  if (!args) return ""
  const candidate =
    args.path ??
    args.file_path ??
    args.filePath ??
    args.command ??
    args.pattern ??
    args.query ??
    args.url ??
    args.directory
  return candidate === undefined || candidate === null ? "" : String(candidate)
}

export function argAt<Content>(value: Content, key: string): string | undefined {
  return stringContent(parseToolArguments(value)?.[key])
}

export function countLines(text?: string) {
  if (!text) return 0
  let lines = 1
  for (const char of text) if (char === "\n") lines += 1
  return lines
}

/** Normalize the edit tool's arguments: a list of edits, or the legacy pair. */
export function editsOf(call: ToolCall): ToolEdit[] {
  const args = parseToolArguments(call.arguments)
  if (!args) return []
  if (Array.isArray(args.edits)) return args.edits.map(parseToolEdit)
  const oldText = stringContent(args.oldText)
  const newText = stringContent(args.newText)
  return oldText === undefined || newText === undefined ? [] : [{ oldText, newText }]
}
