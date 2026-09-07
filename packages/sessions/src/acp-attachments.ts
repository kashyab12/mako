import { z } from "zod"
import { attachmentFromUrl, type AttachmentContent } from "./content.js"

type ContentValue =
  | string
  | number
  | boolean
  | null
  | ContentValue[]
  | { [key: string]: ContentValue | undefined }
const media = z.object({
  type: z.string(),
  data: z.string().optional(),
  blob: z.string().optional(),
  uri: z.string().optional(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
})

/** ACP content may nest media inside tool content or embedded resources. */
export function acpAttachments(
  value: ContentValue | undefined
): AttachmentContent[] {
  if (Array.isArray(value)) return value.flatMap(acpAttachments)
  const parsed = media.safeParse(value)
  if (!parsed.success) return []
  const item = parsed.data
  if (item.type === "content" || item.type === "resource") {
    const nested = z
      .object({ content: z.json().optional(), resource: z.json().optional() })
      .safeParse(value)
    if (!nested.success) return []
    if (nested.data.content) return acpAttachments(nested.data.content)
    const resource = media.safeParse({
      type: "file",
      ...z.record(z.string(), z.json()).parse(nested.data.resource ?? {}),
    })
    return resource.success ? acpAttachments(resource.data) : []
  }
  if (!["image", "audio", "file", "resource_link"].includes(item.type))
    return []
  const mimeType =
    item.mimeType ??
    (item.type === "image"
      ? "image/png"
      : item.type === "audio"
        ? "audio/wav"
        : "application/octet-stream")
  const name = item.name ?? `${item.type}.${mimeType.split("/")[1] ?? "bin"}`
  if (item.data || item.blob)
    return [
      {
        type: "attachment",
        name,
        mimeType,
        source: { kind: "inline", data: item.data ?? item.blob ?? "" },
      },
    ]
  if (item.uri) return [attachmentFromUrl(name, mimeType, item.uri)]
  return [
    {
      type: "attachment",
      name,
      mimeType,
      source: {
        kind: "unavailable",
        reason: "The provider did not retain the attachment bytes",
      },
    },
  ]
}
