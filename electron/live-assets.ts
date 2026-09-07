import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { AttachmentContent } from "@mako/sessions"
import type { LiveUpdate } from "./contracts/live-content.js"

const PREVIEW_LIMIT = 64_000

/** Keep large payloads in durable artifacts, with small references on the event wire. */
export class LiveAssets {
  private readonly root: string
  constructor(root: string) {
    this.root = root
  }

  private save(
    name: string,
    mimeType: string,
    bytes: Buffer
  ): AttachmentContent {
    const digest = createHash("sha256").update(bytes).digest("hex")
    mkdirSync(this.root, { recursive: true })
    const path = join(
      this.root,
      `${digest}-${name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100)}`
    )
    if (!existsSync(path)) {
      const temporary = join(this.root, `${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, bytes)
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    return {
      type: "attachment",
      name,
      mimeType,
      source: { kind: "file", path },
    }
  }

  private attachment(attachment: AttachmentContent): AttachmentContent {
    return attachment.source.kind === "inline"
      ? {
          ...attachment,
          source: this.save(
            attachment.name,
            attachment.mimeType,
            Buffer.from(attachment.source.data, "base64")
          ).source,
        }
      : attachment
  }

  prepare(update: LiveUpdate): LiveUpdate[] {
    if (update.kind === "text" || update.kind === "thinking") {
      if (update.text.length <= PREVIEW_LIMIT) return [update]
      const chunks: LiveUpdate[] = []
      for (let offset = 0; offset < update.text.length; offset += PREVIEW_LIMIT)
        chunks.push({
          ...update,
          text: update.text.slice(offset, offset + PREVIEW_LIMIT),
          replace: offset === 0 ? update.replace : false,
        })
      return chunks
    }
    if (update.kind === "attachment")
      return [{ ...update, attachment: this.attachment(update.attachment) }]
    if (update.kind === "plan") return [update]
    const attachments =
      update.attachments?.map((attachment) => this.attachment(attachment)) ?? []
    if (update.kind === "user") return [{ ...update, attachments }]
    const next = { ...update }
    if (update.attachments) next.attachments = attachments
    for (const field of ["input", "output"] as const) {
      const text = next[field]
      if (!text || text.length <= PREVIEW_LIMIT) continue
      const attachment = this.save(
        `${update.id}-${field}.txt`,
        "text/plain",
        Buffer.from(text)
      )
      attachments.push(attachment)
      next.attachments = attachments
      next[field] =
        `${text.slice(0, PREVIEW_LIMIT)}\n\n[Preview shortened. The complete ${field} is attached as ${attachment.name}.]`
    }
    return [next]
  }
}
