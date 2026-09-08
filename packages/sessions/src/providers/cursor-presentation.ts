import type { ThreadEntry } from "../format.js"
import { clip } from "../format.js"

/** Cursor inserts task completions as user-role records; they are work results, not user turns. */
export function cursorTaskNotification(
  text: string,
  id: string,
  at?: string
): ThreadEntry | undefined {
  const match =
    /^\s*(?:<timestamp>[^<]*<\/timestamp>\s*)?<system_notification>([\s\S]*?)<\/system_notification>\s*<user_query>[\s\S]*?<\/user_query>\s*$/.exec(
      text
    )
  if (!match) return undefined
  const task = /<task>\s*([\s\S]*?)\s*<\/task>/.exec(match[1]!)?.[1]
  if (!task) return undefined
  const title = /^title:\s*(.+)$/m.exec(task)?.[1] ?? "Background task"
  const status = /^status:\s*(\S+)$/m.exec(task)?.[1]
  const output =
    /<response>\s*([\s\S]*?)\s*<\/response>/.exec(task)?.[1] ??
    /<user_visible_high_level_summary>\s*([\s\S]*?)\s*<\/user_visible_high_level_summary>/.exec(
      task
    )?.[1] ??
    task
  return {
    kind: "assistant",
    id,
    at,
    blocks: [
      {
        type: "tool",
        name: "Task result",
        id: `notification:${id}`,
        input: JSON.stringify({ description: title }),
        output: clip(output),
        error: status === "failed",
        canceled: status === "cancelled" || status === "canceled",
      },
    ],
  }
}

/** Keep user-authored XML intact unless the whole prompt has the native wrapper. */
export function cursorPrompt(text: string): string {
  const match =
    /^\s*(?:<timestamp>[^<]*<\/timestamp>\s*)?<user_query>([\s\S]*?)<\/user_query>\s*$/.exec(
      text
    )
  return match?.[1]?.trim() ?? text
}
