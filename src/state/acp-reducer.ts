import type { AcpBlock } from "@/lib/acp-blocks"
import type { AcpUpdate } from "@/lib/types"

export function reduceAcpUpdates(
  blocks: AcpBlock[],
  updates: AcpUpdate[]
): AcpBlock[] {
  const next = [...blocks]
  for (const update of updates) {
    const last = next[next.length - 1]
    switch (update.kind) {
      case "user":
        if (last?.type !== "user" || last.text !== update.text)
          next.push({ type: "user", text: update.text })
        break
      case "text":
        if (last?.type === "text")
          next[next.length - 1] = {
            type: "text",
            text: last.text + update.text,
          }
        else next.push({ type: "text", text: update.text })
        break
      case "thinking":
        if (last?.type === "thinking")
          next[next.length - 1] = {
            type: "thinking",
            text: last.text + update.text,
          }
        else next.push({ type: "thinking", text: update.text })
        break
      case "tool":
        next.push({
          type: "tool",
          id: update.id,
          title: update.title,
          toolKind: update.toolKind,
          status: update.status,
          input: update.input,
        })
        break
      case "tool-update": {
        const index = next.findIndex(
          (block) => block.type === "tool" && block.id === update.id
        )
        const block = next[index]
        if (block?.type === "tool")
          next[index] = {
            ...block,
            title: update.title ?? block.title,
            status: update.status ?? block.status,
            input: update.input ?? block.input,
            output: update.output ?? block.output,
          }
        break
      }
      case "plan": {
        const index = next.findIndex((block) => block.type === "plan")
        if (index >= 0) next.splice(index, 1)
        next.push({ type: "plan", entries: update.entries })
        break
      }
    }
  }
  return next
}
