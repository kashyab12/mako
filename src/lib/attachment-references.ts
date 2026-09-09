import type { Attachment, AttachmentFileReference } from "./attachments"
import { tokenize, type Segment } from "./mentions"
import type { AttachmentContent } from "@mako/sessions"
import { markdownMedia } from "./transcript-media"

export function attachmentReference(
  item: Pick<Attachment, "index" | "reference" | "name">
): string {
  return (
    item.reference ??
    `[${item.name}${item.index > 1 ? ` (${item.index})` : ""}]`
  )
}

export function namedAttachmentReference(
  name: string,
  index: number,
  used: readonly string[]
): string {
  const label = name.replace(/[\r\n]/g, " ")
  const reference = `[${label}]`
  return used.includes(reference) ? `[${label} (${index})]` : reference
}

export interface AttachmentRange {
  item: Attachment
  start: number
  end: number
}

export function attachmentRanges(
  text: string,
  items: readonly Attachment[]
): AttachmentRange[] {
  return items
    .flatMap((item) => {
      const reference = attachmentReference(item)
      const ranges: AttachmentRange[] = []
      let start = text.indexOf(reference)
      while (start !== -1) {
        ranges.push({ item, start, end: start + reference.length })
        start = text.indexOf(reference, start + reference.length)
      }
      return ranges
    })
    .sort((left, right) => left.start - right.start)
}

/** A partial edit of a file reference edits the whole attachment. */
export function editAttachmentReferences(
  before: string,
  after: string,
  items: readonly Attachment[]
) {
  let start = 0
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++
  let end = before.length
  let nextEnd = after.length
  while (
    end > start &&
    nextEnd > start &&
    before[end - 1] === after[nextEnd - 1]
  ) {
    end--
    nextEnd--
  }
  const touched = attachmentRanges(before, items).filter((range) =>
    start === end
      ? range.start < start && range.end > start
      : range.start < end && range.end > start
  )
  if (!touched.length) return { text: after, removed: [], caret: nextEnd }
  const from = Math.min(start, ...touched.map((range) => range.start))
  const to = Math.max(end, ...touched.map((range) => range.end))
  const insertion = after.slice(start, nextEnd)
  const text = before.slice(0, from) + insertion + before.slice(to)
  return {
    text,
    removed: touched
      .map((range) => range.item.id)
      .filter((id) => {
        const item = items.find((entry) => entry.id === id)!
        return !text.includes(attachmentReference(item))
      }),
    caret: from + insertion.length,
  }
}

export function restoreAttachmentReferences(
  text: string,
  items: readonly Attachment[]
): string {
  const restored = items.reduce(
    (body, item) =>
      body.split(`[Attachment ${item.index}]`).join(attachmentReference(item)),
    text
  )
  const missing = items
    .map(attachmentReference)
    .filter((reference) => !restored.includes(reference))
  return missing.length
    ? `${restored}${restored && !restored.endsWith("\n") ? "\n" : ""}${missing.join(" ")}`
    : restored
}

export function attachmentPromptSegments(
  text: string,
  files: readonly AttachmentFileReference[]
): (Segment | { kind: "attachment"; file: AttachmentFileReference })[] {
  const matches = files
    .flatMap((file) => {
      const references = [
        `[Attachment ${file.index}]`,
        `[${file.name}]`,
        `[${file.name} (${file.index})]`,
      ]
      return references.flatMap((reference) => {
        const found = []
        let start = text.indexOf(reference)
        while (start !== -1) {
          found.push({ start, end: start + reference.length, file })
          start = text.indexOf(reference, start + reference.length)
        }
        return found
      })
    })
    .sort((left, right) => left.start - right.start)
  const segments: (
    Segment | { kind: "attachment"; file: AttachmentFileReference }
  )[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    segments.push(...tokenize(text.slice(cursor, match.start)), {
      kind: "attachment",
      file: match.file,
    })
    cursor = match.end
  }
  return [...segments, ...tokenize(text.slice(cursor))]
}

export function reusablePromptAttachments(
  files: readonly AttachmentFileReference[],
  media: readonly AttachmentContent[]
): Attachment[] {
  const paths = new Map(files.map((file) => [file.path, file]))
  for (const attachment of media) {
    if (
      attachment.source.kind === "file" &&
      !paths.has(attachment.source.path)
    ) {
      paths.set(attachment.source.path, {
        index: paths.size + 1,
        name: attachment.name,
        path: attachment.source.path,
      })
    }
  }
  const result: Attachment[] = []
  for (const file of paths.values()) {
    const original = media.find(
      (attachment) =>
        attachment.source.kind === "file" &&
        attachment.source.path === file.path
    )
    const mimeType =
      original?.mimeType ?? markdownMedia(file.path, file.name).mimeType
    result.push({
      id: `reuse:${file.index}:${file.path}`,
      index: file.index,
      reference: namedAttachmentReference(
        file.name,
        file.index,
        result.map(attachmentReference)
      ),
      name: file.name,
      mimeType,
      size: 0,
      kind: mimeType.startsWith("image/") ? "image" : "binary",
      stagedPath: file.path,
    })
  }
  return result
}
