import type { Block, ChatMessage } from "@/lib/types"

export interface AcpPlanEntry {
  content: string
  status: string
}

export type AcpBlock =
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool"
      id: string
      title: string
      toolKind?: string
      status: string
      input?: string
      output?: string
    }
  | { type: "plan"; entries: AcpPlanEntry[] }

export interface AcpConversation {
  messages: ChatMessage[]
  plan: AcpPlanEntry[]
}

export function acpBlocksToMessages(
  blocks: AcpBlock[],
  running: boolean,
  provider?: string
): AcpConversation {
  const messages: ChatMessage[] = []
  let plan: AcpPlanEntry[] = []
  let assistant: ChatMessage | null = null

  const append = (block: Block, index: number) => {
    if (!assistant) {
      assistant = {
        id: `acp-assistant-${index}`,
        role: "assistant",
        blocks: [],
      }
      if (provider) assistant.provider = provider
      messages.push(assistant)
    }
    assistant.blocks.push(block)
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    switch (block.type) {
      case "user":
        assistant = null
        messages.push({
          id: `acp-user-${index}`,
          role: "user",
          blocks: [{ type: "text", text: block.text }],
        })
        break
      case "text":
        append({ type: "text", text: block.text }, index)
        break
      case "thinking":
        append({ type: "thinking", thinking: block.text }, index)
        break
      case "tool": {
        const name = block.toolKind ?? block.title
        append(
          {
            type: "toolCall",
            id: block.id,
            name,
            arguments: block.input,
          },
          index
        )
        const failed = block.status === "failed"
        const canceled = /cancel/i.test(block.status)
        const finished =
          block.output !== undefined ||
          failed ||
          canceled ||
          /complete|done/i.test(block.status)
        if (finished) {
          append(
            {
              type: "toolResult",
              id: block.id,
              name,
              text: block.output ?? (failed ? block.title : ""),
              isError: failed,
              isCanceled: canceled,
            },
            index
          )
        }
        break
      }
      case "plan":
        plan = block.entries
        break
    }
  }

  const last = messages.at(-1)
  if (running && last?.role === "assistant") last.streaming = true
  return { messages, plan }
}
