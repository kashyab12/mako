import assert from "node:assert/strict"
import type { Root } from "mdast"
import { remarkFileCitations } from "../src/lib/citation-markdown.ts"
import { markdownFileTarget } from "../src/lib/file-citations.ts"
const literal = "【F:src/example.ts†L12-L18】"
const code = { type: "code" as const, lang: "text", value: literal }
const inline = { type: "inlineCode" as const, value: literal }
const link = {
  type: "link" as const,
  url: "https://example.com",
  children: [{ type: "text" as const, value: literal }],
}
const tree: Root = {
  type: "root",
  children: [
    {
      type: "paragraph",
      children: [{ type: "text", value: literal }, inline, link],
    },
    code,
    { type: "code", lang: "12:18:src/example.ts", value: "const value = 1" },
  ],
}
remarkFileCitations()(tree)
assert.equal(code.value, literal)
assert.equal(inline.value, literal)
assert.equal(link.children[0]?.value, literal)
assert.equal(
  tree.children[0]?.type === "paragraph" && tree.children[0].children[0]?.type,
  "link"
)
assert.ok(JSON.stringify(tree).includes("src/example.ts#L12-L18"))
for (const target of [
  "/work/src/example.ts:12",
  "src/example.ts#L12-L18",
  "file:///work/src/example.ts:12",
  "vscode://file/work/src/example.ts:12",
])
  assert.equal(markdownFileTarget(target)?.line, 12, target)
console.log(
  "Provider citations preserve literal code and resolve file URLs, editor links, line suffixes, and Cursor code ranges"
)
