import type { AcpLaunch } from "../acp-source.js"

/** Cursor's completion updates use "MCP: tool" even when permission named it. */
export function cursorNotifications(): NonNullable<AcpLaunch["notifications"]> {
  const titles = new Map<string, string>()
  return {
    permission({ toolCall }) {
      if (!toolCall.title || toolCall.title === "MCP: tool") return
      titles.set(toolCall.toolCallId, toolCall.title)
      if (titles.size > 256) {
        const oldest = titles.keys().next().value
        if (oldest !== undefined) titles.delete(oldest)
      }
    },
    update(notification) {
      const { update } = notification
      if (
        update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update"
      )
        return notification
      const title = titles.get(update.toolCallId)
      if (!title || update.title !== "MCP: tool") return notification
      return { ...notification, update: { ...update, title } }
    },
  }
}
