import type { Root, PhrasingContent } from "mdast"
import { visit } from "unist-util-visit"
import { inlineFileTarget, linkFileCitations } from "./file-citations"

/** Transform prose nodes only; code examples and link labels remain literal. */
export function remarkFileCitations() {
  return (tree: Root) => {
    visit(tree, "text", (node, index, parent) => {
      if (
        index === undefined ||
        !parent ||
        parent.type === "link" ||
        parent.type === "linkReference"
      )
        return
      const linked = linkFileCitations(node.value)
      if (linked === node.value) return
      const children: PhrasingContent[] = []
      let offset = 0
      for (const match of linked.matchAll(
        /\[([^\]]+)\]\((mako-citation:[^)]+)\)/g
      )) {
        if (match.index > offset)
          children.push({
            type: "text",
            value: linked.slice(offset, match.index),
          })
        children.push({
          type: "link",
          url: match[2]!,
          children: [
            {
              type: "text",
              value: match[1]!.replaceAll("\\[", "[").replaceAll("\\]", "]"),
            },
          ],
        })
        offset = match.index + match[0].length
      }
      if (offset < linked.length)
        children.push({ type: "text", value: linked.slice(offset) })
      parent.children.splice(index, 1, ...children)
      return index + children.length
    })
    visit(tree, "inlineCode", (node, index, parent) => {
      if (index === undefined || !parent || parent.type === "link" || parent.type === "linkReference") return
      if (!inlineFileTarget(node.value)) return
      parent.children.splice(index, 1, {type: "link", url: node.value, children: [node]})
      return index + 1
    })
    visit(tree, "code", (node, index, parent) => {
      const citation = /^(\d+):(\d+):(.+)$/.exec(node.lang ?? "")
      if (!citation || index === undefined || !parent) return
      const path = citation[3]!
      node.lang = path.split(".").at(-1) ?? null
      parent.children.splice(index, 0, {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: `${path}#L${citation[1]}-L${citation[2]}`,
            children: [
              { type: "text", value: `${path}:${citation[1]}–${citation[2]}` },
            ],
          },
        ],
      })
      return index + 2
    })
  }
}
