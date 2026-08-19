import type { Block, PiMessage, ThreadEntry } from "@/lib/types"

export function threadToMessages(entries: ThreadEntry[], indexStart = 0): PiMessage[] {
  const messages: PiMessage[] = []

  for (let localIndex = 0; localIndex < entries.length; localIndex += 1) {
    const entry = entries[localIndex]!
    const entryIndex = indexStart + localIndex
    const messageId = `foreign-entry-${entryIndex}`
    if (entry.kind === "user") {
      messages.push({
        id: messageId,
        role: "user",
        blocks: [{ type: "text", text: entry.text }],
        ...(entry.at ? { timestamp: Date.parse(entry.at) || undefined } : {}),
      })
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
          blocks.push({
            type: "toolResult",
            id: callId,
            name: block.name,
            text: block.output,
            ...(block.error ? { isError: true } : {}),
          })
        }
      }
    }
    if (blocks.length === 0) continue
    messages.push({
      id: messageId,
      role: "assistant",
      blocks,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.at ? { timestamp: Date.parse(entry.at) || undefined } : {}),
    })
  }
  return messages
}
