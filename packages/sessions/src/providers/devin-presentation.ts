import { z } from "zod"
import type { AttachmentContent } from "../content.js"

/** Keep quoted/code examples literal while interpreting the provider's reference markup. */
export function devinReferences(text: string): string {
  return text
    .split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /<ref_snippet\s+file="([^"\n]+)"\s+lines="(\d+)(?:-(\d+))?"\s*\/>/g,
            (_match, path: string, start: string, end: string | undefined) => {
              const href = encodeURI(path)
                .replaceAll("(", "%28")
                .replaceAll(")", "%29")
              const label =
                path
                  .split("/")
                  .at(-1)
                  ?.replaceAll("[", "\\[")
                  .replaceAll("]", "\\]") ?? "File"
              return `[${label}:${start}${end ? `-${end}` : ""}](<${href}#L${start}${end ? `-L${end}` : ""}>)`
            }
          )
    )
    .join("")
}

export function devinPromptImages(text: string) {
  const attachments: AttachmentContent[] = []
  const body = text
    .split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /\[Image\s+\d+:\s*(\/[^\]\n]+\.(png|jpe?g|webp|gif))\]/gi,
            (_match, path: string, extension: string) => {
              attachments.push({
                type: "attachment",
                name: path.split("/").at(-1) ?? "Image",
                mimeType: `image/${/^jpe?g$/i.test(extension) ? "jpeg" : extension.toLowerCase()}`,
                source: { kind: "file", path },
              })
              return ""
            }
          )
    )
    .join("")
  return { text: body.trim(), attachments }
}

const McpCall = z.object({
  server_name: z.string(),
  tool_name: z.string(),
  arguments: z.record(z.string(), z.json()),
})
export function devinMcpCall(
  input: string | undefined
): { name: string; input: string } | undefined {
  if (!input) return undefined
  try {
    const parsed = McpCall.safeParse(JSON.parse(input))
    return parsed.success
      ? {
          name: `${parsed.data.server_name}.${parsed.data.tool_name}`,
          input: JSON.stringify(parsed.data.arguments),
        }
      : undefined
  } catch {
    return undefined
  }
}
