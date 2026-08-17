/**
 * Composer references.
 *
 * `@path/to/file` and `$skill-name` are plain text in the prompt — Pi receives
 * exactly what is on screen, and nothing has to round-trip through a richer
 * document model. The tokenizer below is what lets the same string render as
 * chips in the composer and in the transcript.
 */

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; raw: string }
  | { kind: "skill"; name: string; raw: string }

/**
 * A file token runs to the next whitespace. Paths do not contain spaces often
 * enough to justify a quoting syntax, and a wrong split is visible and
 * immediately fixable, whereas a quoting rule is neither.
 */
const TOKEN = /(^|\s)([@$])([^\s]+)/g

export function tokenize(text: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0

  for (const match of text.matchAll(TOKEN)) {
    const [, lead, sigil, body] = match
    const start = (match.index ?? 0) + lead.length
    if (!body) continue

    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) })

    const raw = `${sigil}${body}`
    segments.push(
      sigil === "@"
        ? { kind: "file", path: body, raw }
        : { kind: "skill", name: body, raw }
    )
    cursor = start + raw.length
  }

  if (cursor === 0) return [{ kind: "text", text }]
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) })
  return segments
}

export function hasReferences(text: string): boolean {
  TOKEN.lastIndex = 0
  return TOKEN.test(text)
}

/** The reference being typed at the caret, if any. */
export interface ActiveMention {
  sigil: "@" | "$"
  query: string
  /** Offsets of the token in the source string, for replacement. */
  start: number
  end: number
}

export function mentionAt(text: string, caret: number): ActiveMention | null {
  // Scan back from the caret to the sigil, stopping at whitespace.
  let index = caret - 1
  while (index >= 0 && !/\s/.test(text[index])) {
    const char = text[index]
    if (char === "@" || char === "$") {
      // A sigil only opens a mention at a word boundary.
      const before = index === 0 ? " " : text[index - 1]
      if (!/\s/.test(before)) return null
      return {
        sigil: char,
        query: text.slice(index + 1, caret),
        start: index,
        end: caret,
      }
    }
    index -= 1
  }
  return null
}

export function replaceMention(text: string, mention: ActiveMention, value: string) {
  const inserted = `${value} `
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length,
  }
}

/** Map a file extension to a coarse kind, for the chip glyph. */
export function fileKind(path: string): "code" | "style" | "config" | "doc" | "image" | "file" {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "rb", "java", "c", "h", "cpp", "swift", "kt", "sh"].includes(ext)) {
    return "code"
  }
  if (["css", "scss", "less", "pcss"].includes(ext)) return "style"
  if (["json", "yaml", "yml", "toml", "ini", "env", "lock"].includes(ext)) return "config"
  if (["md", "mdx", "txt", "rst"].includes(ext)) return "doc"
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"].includes(ext)) return "image"
  return "file"
}
