import type { Block, PiMessage, ThreadEntry } from "@/lib/types"

/**
 * A foreign conversation, in this app's native message shape.
 *
 * The canonical thread format exists for interchange; the transcript
 * components exist for reading. This is the bridge: a Codex or Claude Code
 * session converted here renders through exactly the same prompt cards,
 * markdown prose, and tool rows as a native conversation — because a
 * conversation is a conversation, and only the mark in the corner should
 * say where it happened.
 */
export function threadToMessages(entries: ThreadEntry[], idStart = 0): PiMessage[] {
  const messages: PiMessage[] = []
  let counter = idStart
  const nextId = () => `foreign-${counter++}`

  for (const entry of entries) {
    if (entry.kind === "user") {
      messages.push({
        id: nextId(),
        role: "user",
        blocks: [{ type: "text", text: entry.text }],
        ...(entry.at ? { timestamp: Date.parse(entry.at) || undefined } : {}),
      })
      continue
    }
    if (entry.kind === "event") {
      messages.push({
        id: nextId(),
        role: "system",
        blocks: [{ type: "text", text: entry.detail ? `${entry.label} — ${entry.detail}` : entry.label }],
      })
      continue
    }
    const blocks: Block[] = []
    for (const block of entry.blocks) {
      if (block.type === "text") blocks.push({ type: "text", text: block.text })
      if (block.type === "thinking") blocks.push({ type: "thinking", thinking: block.text })
      if (block.type === "tool") {
        const callId = nextId()
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
      id: nextId(),
      role: "assistant",
      blocks,
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.at ? { timestamp: Date.parse(entry.at) || undefined } : {}),
    })
  }
  return messages
}
