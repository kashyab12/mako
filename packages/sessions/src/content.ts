import { z } from "zod"

/** Portable attachment references. Inline data is retained only within reader budgets. */
export const AttachmentSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string().min(1),
    originalPath: z.string().optional(),
  }),
  z.object({ kind: z.literal("url"), url: z.string().min(1) }),
  z.object({ kind: z.literal("inline"), data: z.string() }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])

export const AttachmentContentSchema = z.object({
  type: z.literal("attachment"),
  id: z.string().optional(),
  name: z.string(),
  mimeType: z.string(),
  source: AttachmentSourceSchema,
})

export type AttachmentContent = z.infer<typeof AttachmentContentSchema>

export function attachmentFromUrl(
  name: string,
  mimeType: string,
  url: string
): AttachmentContent {
  if (url.startsWith("file://")) {
    const file = new URL(url)
    if (!file.hostname || file.hostname === "localhost")
      return {
        type: "attachment",
        name,
        mimeType,
        source: { kind: "file", path: decodeURIComponent(file.pathname) },
      }
  }
  const data = /^data:([^;,]+)?;base64,([\s\S]*)$/.exec(url)
  return {
    type: "attachment",
    name,
    mimeType: data?.[1] || mimeType,
    source: data
      ? { kind: "inline", data: data[2] ?? "" }
      : { kind: "url", url },
  }
}

export function attachmentDescription(attachment: AttachmentContent): string {
  switch (attachment.source.kind) {
    case "file":
      return `${attachment.name}: ${attachment.source.path}`
    case "url":
      return `${attachment.name}: ${attachment.source.url}`
    case "inline":
      return `${attachment.name}: inline ${attachment.mimeType} attachment`
    case "unavailable":
      return `${attachment.name}: ${attachment.source.reason}`
  }
}
