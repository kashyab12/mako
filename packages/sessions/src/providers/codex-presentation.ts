import { type AttachmentContent } from "../content.js"
import { extname, basename } from "node:path"
import { z } from "zod"
import { userTextFrom } from "../format.js"

const QuestionReplies = z
  .array(z.object({ question: z.string(), answer: z.string() }))
  .min(1)
const ReviewComment = z.object({
  title: z.string(),
  body: z.string(),
  file: z.string().min(1),
  start: z.coerce.number().int().positive().optional(),
})
const IMAGE_APPENDIX =
  /(?:\s*<image name=\[Image #\d+\] path="[^"\n]+"><\/image>)+\s*$/

/** Only the complete provider envelopes are presentation metadata; examples stay literal. */
export function codexPrompt(text: string): string | undefined {
  let body = userTextFrom(text)
  if (!body) return undefined
  body = body.replace(
    /^# AGENTS\.md instructions for [^\n]+\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/,
    ""
  )
  body = userTextFrom(body)
  if (!body) return undefined
  const reply =
    /^<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>$/.exec(
      body
    )
  if (reply) {
    try {
      const parsed = QuestionReplies.safeParse(JSON.parse(reply[1]!))
      if (parsed.success)
        return parsed.data
          .map(({ question, answer }) => `${question}\n\n${answer}`)
          .join("\n\n")
    } catch {
      /* A malformed envelope remains readable verbatim. */
    }
  }
  return body.replace(IMAGE_APPENDIX, "").trim() || undefined
}

function reviewComment(directive: string, attributes: string): string {
  const fields: Record<string, string> = {}
  const tokens = /([a-z]+)=("(?:[^"\\]|\\.)*"|\d+)/g
  let consumed = ""
  for (const match of attributes.matchAll(tokens)) {
    consumed += match[0]
    const value = match[2]!
    try {
      fields[match[1]!] = value.startsWith('"')
        ? z.string().parse(JSON.parse(value))
        : value
    } catch {
      return directive
    }
  }
  if (consumed.replace(/\s/g, "") !== attributes.replace(/\s/g, ""))
    return directive
  const parsed = ReviewComment.safeParse(fields)
  if (!parsed.success) return directive
  const { title, body, file, start } = parsed.data
  const path = encodeURI(file).replaceAll("(", "%28").replaceAll(")", "%29")
  const label = file.replaceAll("[", "\\[").replaceAll("]", "\\]")
  return `> **${title}**\n>\n> ${body.replaceAll("\n", "\n> ")}\n>\n> [${label}${start ? `:${start}` : ""}](<${path}${start ? `#L${start}` : ""}>)`
}

function reviewLink(href: string): string {
  try {
    const review = new URL(href)
    const pr = new URL(review.searchParams.get("pr") ?? "")
    if (pr.protocol !== "https:" || pr.username || pr.password) return href
    return pr.href
  } catch { return href }
}

export function codexPresentation(text: string): string {
  return text.split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,})/g).map((part, index) => index % 2 ? part : part
    .replace(/^::code-comment\{([^\n]*)\}\s*$/gm, reviewComment)
    .split(/(`[^`\n]*`)/g).map((span, position) => position % 2 ? span : span.replace(/codex:\/\/review\?[^\s)<>]+/g, reviewLink)).join("")
  ).join("")
}

export function codexPromptImages(text: string): AttachmentContent[] {
  const appendix = IMAGE_APPENDIX.exec(text)?.[0]
  if (!appendix) return []
  return [...appendix.matchAll(/path="([^"\n]+)"/g)].map((match) => {
    const path = match[1]!
    const extension = extname(path).slice(1).toLowerCase()
    return {
      type: "attachment",
      name: basename(path),
      mimeType: `image/${/jpe?g/.test(extension) ? "jpeg" : extension || "png"}`,
      source: { kind: "file", path },
    }
  })
}
