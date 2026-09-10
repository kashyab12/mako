import { memo } from "react"
import { tokenize } from "@/lib/mentions"
import { attachmentRanges } from "@/lib/attachment-references"
import type { Attachment } from "@/lib/attachments"
import { InlineAttachment } from "./attachments"

/**
 * The painted layer behind the composer's textarea.
 *
 * It must match the textarea's box and metrics exactly — same padding, same
 * font, same leading, same wrapping — because the caret the user sees belongs
 * to the textarea and this layer only supplies the glyphs. Any divergence
 * shows up immediately as text drifting away from the cursor.
 */
export const ReferenceOverlay = memo(function ReferenceOverlay({
  text,
  attachments,
}: {
  text: string
  attachments: Attachment[]
}) {
  const ranges = attachmentRanges(text, attachments)
  const pieces = []
  let cursor = 0
  for (const range of ranges) {
    pieces.push(...tokenize(text.slice(cursor, range.start)))
    pieces.push({
      kind: "attachment" as const,
      item: range.item,
      raw: text.slice(range.start, range.end),
    })
    cursor = range.end
  }
  const segments = [...pieces, ...tokenize(text.slice(cursor))]

  return (
    <div
      // `inset-x-0 top-0` and **no** `bottom`: inside a scrolling box,
      // `inset-0` resolves `bottom` against the *visible* height, so the
      // painted layer was exactly one screenful tall no matter how long the
      // draft was. Everything below that had no glyphs — and since the
      // textarea's own text is transparent, it simply disappeared as you
      // typed past the fold. Letting the height come from the content makes it
      // match the textarea's scroll height, which is the whole contract.
      className="pointer-events-none absolute inset-x-0 top-0 px-4 pt-4 pb-2 font-sans text-prose leading-[1.6] break-words whitespace-pre-wrap text-foreground"
    >
      {segments.map((segment, index) => {
        if (segment.kind === "attachment")
          return (
            <InlineAttachment
              key={index}
              item={segment.item}
              reference={segment.raw}
            />
          )
        if (segment.kind === "text")
          return (
            <span aria-hidden key={index}>
              {segment.text}
            </span>
          )
        if (segment.kind === "file" || segment.kind === "thread") {
          return (
            <span
              key={index}
              // Sized to the glyphs it replaces so wrapping stays identical:
              // the chip is a background, not a differently-shaped box.
              className="rounded-[3px] bg-raised text-foreground ring-1 ring-hairline ring-inset"
              title={
                segment.kind === "file"
                  ? segment.path
                  : `${segment.harness} conversation`
              }
            >
              {segment.raw}
            </span>
          )
        }
        return (
          <span
            key={index}
            className="rounded-[3px] bg-fill-selected text-foreground ring-1 ring-border ring-inset"
          >
            {segment.raw}
          </span>
        )
      })}
      {/* A trailing newline keeps the last line's height when the draft ends
          with a break, matching how the textarea measures itself. */}
      {text.endsWith("\n") ? <span>{"​"}</span> : null}
    </div>
  )
})
