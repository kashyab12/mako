import type { Block, ChatMessage, ThreadEntry } from "@/lib/types"

const INPUT_TOOLS = new Set([
  "askquestion",
  "askuserquestion",
  "awaituserinput",
  "humaninput",
  "promptuser",
  "question",
  "requestuserinput",
])

function isInputTool(name: string): boolean {
  return INPUT_TOOLS.has(name.toLowerCase().replace(/[^a-z0-9]/g, ""))
}

export function pendingThreadInput(entries: ThreadEntry[]): string | null {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex]
    if (entry?.kind !== "assistant") continue
    for (let blockIndex = entry.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = entry.blocks[blockIndex]
      if (block?.type !== "tool" || !isInputTool(block.name)) continue
      return block.output === undefined ? block.name : null
    }
  }
  return null
}

export function threadToMessages(entries: ThreadEntry[], indexStart = 0): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (let localIndex = 0; localIndex < entries.length; localIndex += 1) {
    const entry = entries[localIndex]!
    const entryIndex = indexStart + localIndex
    const messageId = `foreign-entry-${entryIndex}`
    if (entry.kind === "user") {
      const message: ChatMessage = {
        id: messageId,
        role: "user",
        blocks: [{ type: "text", text: entry.text }],
      }
      if (entry.at) message.timestamp = Date.parse(entry.at) || undefined
      messages.push(message)
      continue
    }
    if (entry.kind === "event") {
      messages.push({
        id: messageId,
        role: "system",
        blocks: [{ type: "text", text: entry.detail ? `${entry.label} — ${entry.detail}` : entry.label }],
      })
      continue
    }
    const blocks: Block[] = []
    for (let blockIndex = 0; blockIndex < entry.blocks.length; blockIndex += 1) {
      const block = entry.blocks[blockIndex]!
      if (block.type === "text") blocks.push({ type: "text", text: block.text })
      if (block.type === "thinking") blocks.push({ type: "thinking", thinking: block.text })
      if (block.type === "tool") {
        const callId = `${messageId}-tool-${blockIndex}`
        blocks.push({ type: "toolCall", id: callId, name: block.name, arguments: block.input })
        if (block.output !== undefined) {
          const result: Block = {
            type: "toolResult",
            id: callId,
            name: block.name,
            text: block.output,
          }
          if (block.error) result.isError = true
          blocks.push(result)
        }
      }
    }
    if (blocks.length === 0) continue
    const message: ChatMessage = {
      id: messageId,
      role: "assistant",
      blocks,
    }
    if (entry.model) message.model = entry.model
    if (entry.at) message.timestamp = Date.parse(entry.at) || undefined
    messages.push(message)
  }
  return messages
}
