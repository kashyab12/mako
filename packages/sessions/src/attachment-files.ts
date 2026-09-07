import type { ThreadEntry } from "./format.js"

/** Exact provider-referenced files, used to authorize artifact reads outside a workspace. */
export function attachmentFiles(entries: ThreadEntry[]): string[] {
  return entries.flatMap((entry) => {
    const attachments =
      entry.kind === "user"
        ? (entry.attachments ?? [])
        : entry.kind === "assistant"
          ? entry.blocks.flatMap((block) =>
              block.type === "attachment"
                ? [block]
                : block.type === "tool"
                  ? (block.attachments ?? [])
                  : []
            )
          : []
    return attachments.flatMap((attachment) =>
      attachment.source.kind === "file" ? [attachment.source.path] : []
    )
  })
}
