import { z } from "zod"

export interface FileCitation {
  path: string
  line?: number
  endLine?: number
  purpose?: string
}

const CODEX_CITATION =
  /:codex-file-citation\{path=(?:"([^"]+)"|'([^']+)')(?:\s+purpose=(?:"([^"]*)"|'([^']*)'))?\}/g
const CODEX_LINE_CITATION = /【F:([^†]+)†L(\d+)(?:-L?(\d+))?】/g
const CITATION_SCHEME = "mako-citation:"
const FileCitationSchema = z.object({
  path: z.string().min(1).max(16_384),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  purpose: z.string().max(256).optional(),
})

function citationHref(citation: FileCitation): string {
  return `${CITATION_SCHEME}${encodeURIComponent(JSON.stringify(citation))}`
}

function labelFor(path: string): string {
  const label = path.split(/[\\/]/).pop() || path
  return label.replaceAll("[", "\\[").replaceAll("]", "\\]")
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function citationMarkdown(citation: FileCitation): string {
  const suffix = citation.line
    ? `:${citation.line}${citation.endLine ? `–${citation.endLine}` : ""}`
    : ""
  return `[${labelFor(citation.path)}${suffix}](${citationHref(citation)})`
}

export function linkFileCitations(text: string): string {
  return text
    .replace(
      CODEX_CITATION,
      (_match, doublePath, singlePath, doublePurpose, singlePurpose) =>
        citationMarkdown({
          path: doublePath ?? singlePath,
          purpose: doublePurpose ?? singlePurpose,
        })
    )
    .replace(CODEX_LINE_CITATION, (_match, path, line, endLine) =>
      citationMarkdown({
        path,
        line: Number(line),
        endLine: endLine ? Number(endLine) : undefined,
      })
    )
}

export function decodeFileCitation(
  href: string | undefined
): FileCitation | null {
  if (!href?.startsWith(CITATION_SCHEME)) return null
  try {
    return FileCitationSchema.parse(
      JSON.parse(decodeURIComponent(href.slice(CITATION_SCHEME.length)))
    )
  } catch {
    return null
  }
}

export function markdownFileTarget(
  href: string | undefined
): FileCitation | null {
  if (!href) return null
  const citation = decodeFileCitation(href)
  if (citation) return citation
  let target = href
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target)
      if (url.hostname && url.hostname !== "localhost") return null
      target = url.pathname + url.hash
    } catch {
      return null
    }
  } else if (/^(?:vscode|vscode-insiders|cursor):\/\/file\//i.test(target)) {
    target = target.replace(/^(?:vscode|vscode-insiders|cursor):\/\/file/i, "")
  }
  const local =
    !/^[a-z][a-z0-9+.-]*:/i.test(target) &&
    !target.startsWith("#") &&
    (/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(target) ||
      /[\\/]/.test(target) ||
      /\.[A-Za-z0-9_-]+(?::|#|$)/.test(target))
  if (local) {
    const match = /^(.*?)(?:(?:#L|:)(\d+)(?:-L?(\d+)|:\d+)?)?$/.exec(target)
    if (!match?.[1]) return null
    return {
      path: decodePath(match[1]),
      line: match[2] ? Number(match[2]) : undefined,
      endLine: match[3] ? Number(match[3]) : undefined,
    }
  }
  return null
}


/** Inline code becomes a file action only when the whole span is a recognizable path. */
export function inlineFileTarget(text: string): FileCitation | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /[\n\r`<>|;&=]/.test(text)) return null
  const target = markdownFileTarget(text)
  if (!target || !/\.(?:[cm]?[jt]sx?|json[cl]?|mdx?|markdown|py|rs|go|java|swift|kt|c|cpp|h|hpp|css|scss|sass|less|html?|vue|svelte|sh|bash|zsh|ya?ml|toml|ini|cfg|conf|sql|graphql|proto|txt|csv|tsv|xml|log|png|jpe?g|gif|webp|svg|pdf|mp[34]|wav|mov|webm)$/i.test(target.path)) return null
  if (!/^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(target.path) && /\s/.test(target.path)) return null
  return target
}
