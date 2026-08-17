import { memo } from "react"
import { tokenize } from "@/lib/mentions"

/**
 * The painted layer behind the composer's textarea.
 *
 * It must match the textarea's box and metrics exactly — same padding, same
 * font, same leading, same wrapping — because the caret the user sees belongs
 * to the textarea and this layer only supplies the glyphs. Any divergence
 * shows up immediately as text drifting away from the cursor.
 */
export const ReferenceOverlay = memo(function ReferenceOverlay({ text }: { text: string }) {
  const segments = tokenize(text)

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden px-3 pt-2.5 pb-1 font-sans text-[13.5px] leading-[1.55] break-words whitespace-pre-wrap text-foreground"
    >
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={index}>{segment.text}</span>
        if (segment.kind === "file") {
          return (
            <span
              key={index}
              // Sized to the glyphs it replaces so wrapping stays identical:
              // the chip is a background, not a differently-shaped box.
              className="rounded-[3px] bg-raised text-foreground ring-1 ring-hairline ring-inset"
              title={segment.path}
            >
              {segment.raw}
            </span>
          )
        }
        return (
          <span
            key={index}
            className="rounded-[3px] bg-brand-soft text-foreground ring-1 ring-border ring-inset"
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
