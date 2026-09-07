import type { Block, ChatMessage } from "@/lib/types"

export interface AcpPlanEntry {
  content: string
  status: string
}

import type { LiveBlock as AcpBlock } from "../../electron/contracts/live-content"
export type { LiveBlock as AcpBlock } from "../../electron/contracts/live-content"

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
  let turn = 0

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
        turn += 1
        assistant = null
        messages.push({
          id: `acp-user-${index}`,
          role: "user",
          blocks: [
            { type: "text", text: block.text },
            ...(block.attachments ?? []),
          ],
        })
        break
      case "text":
        append({ type: "text", text: block.text }, index)
        break
      case "attachment":
        append(block.attachment, index)
        break
      case "thinking":
        append({ type: "thinking", thinking: block.text }, index)
        break
      case "tool": {
        const name = block.toolKind ?? block.title
        append(
          {
            type: "toolCall",
            id: `${turn}:${block.id}`,
            name,
            arguments: block.input,
          },
          index
        )
        const failed = block.status === "failed"
        const canceled = /cancel/i.test(block.status)
        const finished =
          failed || canceled || /complete|done/i.test(block.status)
        if (finished || block.output !== undefined) {
          append(
            {
              type: "toolResult",
              id: `${turn}:${block.id}`,
              name,
              text: block.output ?? (failed ? block.title : ""),
              isError: failed,
              isCanceled: canceled,
              streaming: !finished,
              attachments: block.attachments,
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
