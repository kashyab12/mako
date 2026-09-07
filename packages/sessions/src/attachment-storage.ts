import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AttachmentContent } from "./content.js"
import type { Thread } from "./format.js"

/** Retain original attachment bytes independently of a provider's temporary file. */
export async function persistThreadAttachments(
  thread: Thread,
  root: string,
  previous?: Thread | null
): Promise<Thread> {
  const retained = new Map<string, AttachmentContent>()
  for (const entry of previous?.entries ?? []) {
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
    for (const attachment of attachments)
      if (attachment.source.kind === "file" && attachment.source.originalPath)
        retained.set(attachment.source.originalPath, attachment)
  }
  const save = async (
    attachment: AttachmentContent
  ): Promise<AttachmentContent> => {
    if (
      attachment.source.kind === "url" ||
      attachment.source.kind === "unavailable"
    )
      return attachment
    await mkdir(root, { recursive: true })
    const temporary = join(root, `${randomUUID()}.tmp`)
    try {
      if (attachment.source.kind === "inline")
        await writeFile(temporary, attachment.source.data, "base64")
      else await copyFile(attachment.source.path, temporary)
      const digest = createHash("sha256")
      for await (const chunk of createReadStream(temporary))
        digest.update(chunk)
      const name =
        attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) ||
        "attachment"
      const path = join(root, `${digest.digest("hex")}-${name}`)
      await rename(temporary, path)
      return {
        ...attachment,
        source: {
          kind: "file",
          path,
          originalPath:
            attachment.source.kind === "file"
              ? (attachment.source.originalPath ?? attachment.source.path)
              : undefined,
        },
      }
    } catch (error) {
      if (attachment.source.kind === "inline") return attachment
      const existing = retained.get(
        attachment.source.originalPath ?? attachment.source.path
      )
      if (existing) return { ...attachment, source: existing.source }
      return {
        ...attachment,
        source: {
          kind: "unavailable",
          reason: `The original attachment could not be retained: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const entries = []
  for (const entry of thread.entries) {
    if (entry.kind === "user" && entry.attachments) {
      const attachments = []
      for (const attachment of entry.attachments ?? [])
        attachments.push(await save(attachment))
      entries.push({ ...entry, attachments })
    } else if (entry.kind === "assistant") {
      const blocks = []
      for (const block of entry.blocks) {
        if (block.type === "attachment") blocks.push(await save(block))
        else if (block.type === "tool" && block.attachments) {
          const attachments = []
          for (const attachment of block.attachments)
            attachments.push(await save(attachment))
          blocks.push({ ...block, attachments })
        } else blocks.push(block)
      }
      entries.push({ ...entry, blocks })
    } else entries.push(entry)
  }
  return { ...thread, entries }
}
