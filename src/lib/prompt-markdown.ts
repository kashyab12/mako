import type { PhrasingContent, Root } from "mdast"
import { visit } from "unist-util-visit"
import { attachmentPromptSegments } from "./attachment-references"
import type { AttachmentFileReference } from "./attachments"

export type PromptReference = Exclude<ReturnType<typeof attachmentPromptSegments>[number], { kind: "text" }>

function referenceUrl(reference: PromptReference): string {
  const key = reference.kind === "attachment" ? `attachment:${reference.file.index}` : reference.raw
  return `mako-reference:${encodeURIComponent(key)}`
}

export function remarkPromptReferences({ files, references }: { files: readonly AttachmentFileReference[]; references: Map<string, PromptReference> }) {
  return (tree: Root) => {
    visit(tree, "link", (node, index, parent) => {
      if (index === undefined || !parent || !node.url.startsWith("mailto:")) return
      const before = parent.children[index - 1]
      const after = parent.children[index + 1]
      const content = node.children[0]
      if (before?.type !== "text" || after?.type !== "text" || content?.type !== "text") return
      const start = before.value.lastIndexOf("[")
      const end = after.value.indexOf("]")
      const label = before.value.slice(start + 1) + content.value + after.value.slice(0, end)
      if (start < 0 || end < 0 || !files.some((file) => label === file.name || label === `${file.name} (${file.index})`)) return
      parent.children.splice(index, 1, { type: "text", value: content.value, position: node.position })
      return index + 1
    })
    visit(tree, (node) => {
      if (!("children" in node)) return
      for (let index = node.children.length - 1; index > 0; index--) {
        const left = node.children[index - 1]
        const right = node.children[index]
        if (left?.type !== "text" || right?.type !== "text") continue
        left.value += right.value
        if (left.position && right.position) left.position.end = right.position.end
        node.children.splice(index, 1)
      }
    })
    visit(tree, "text", (node, index, parent) => {
      if (index === undefined || !parent || parent.type === "link" || parent.type === "linkReference") return
      const segments = attachmentPromptSegments(node.value, files)
      if (segments.every((segment) => segment.kind === "text")) return
      for (const segment of segments)
        if (segment.kind !== "text") references.set(referenceUrl(segment), segment)
      const children: PhrasingContent[] = segments.map((segment) => segment.kind === "text"
        ? { type: "text", value: segment.text }
        : { type: "link", url: referenceUrl(segment), children: [{ type: "text", value: segment.kind === "attachment" ? segment.file.name : segment.raw }] })
      parent.children.splice(index, 1, ...children)
      return index + children.length
    })
  }
}
