import { z } from "zod"
import {
  AttachmentContentSchema,
  attachmentDescription,
  type AttachmentContent,
} from "./content.js"

const START = "\n<mako-attachments>\n"
const END = "\n</mako-attachments>"
/** Portable references used only when importing into a provider's text-only history. */
export function attachmentEnvelope(attachments: AttachmentContent[]): string {
  return attachments.length ? START + JSON.stringify(attachments) + END : ""
}

export function extractAttachmentEnvelope(text: string) {
  const attachments: AttachmentContent[] = []
  const body = text.replace(
    /\n<mako-attachments>\n([\s\S]*?)\n<\/mako-attachments>/g,
    (original, serialized: string) => {
      try {
        attachments.push(
          ...z.array(AttachmentContentSchema).parse(JSON.parse(serialized))
        )
        return ""
      } catch {
        return original
      }
    }
  )
  return { text: body, attachments }
}

export function describeAttachments(attachments: AttachmentContent[]): string {
  return (
    attachments.map(attachmentDescription).join("\n") +
    attachmentEnvelope(attachments)
  )
}
