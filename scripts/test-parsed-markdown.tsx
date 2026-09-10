import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { remarkFileCitations } from "../src/lib/citation-markdown"
import {
  parseProse,
  reuseParsedProse,
  skipMarkdownParse,
} from "../src/lib/parsed-markdown"

const cases = [
  "Heading\n=======\n\nParagraph **bold** and _emphasis_.",
  "- first\n\n  second paragraph\n\n  - nested\n\n- second\n\nAfter list.",
  "| A | B |\n|---|---|\n| one | two |\n\n- [x] done\n- [ ] pending",
  "A [reference][target] and note[^1].\n\n[target]: https://example.test\n\n[^1]: Endnote with **formatting**.",
  "```typescript\nconst text = '[example](javascript:alert(1))'\n```\n\n`src/app.ts:42`\n\n```12:14:src/app.ts\nconst x = 1\n```",
  "<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![bad](data:text/html,hello)",
  "A hanging **marker and [unfinished](https://example.test",
  "\u{1D49C} 中文 café\n\n> Quoted text\n>\n> second paragraph",
]
for (const text of cases) {
  const tree = parseProse(text)
  const original = structuredClone(tree)
  const expected = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm, remarkFileCitations] }, text)
  )
  for (let count = 0; count < 2; count++) {
    const actual = renderToStaticMarkup(
      createElement(Markdown, { remarkPlugins: [skipMarkdownParse], rehypePlugins: [[reuseParsedProse, tree]] }, text)
    )
    assert.equal(actual, expected)
    assert.deepEqual(
      tree,
      original,
      "React Markdown postprocessing must not mutate the cached worker tree"
    )
  }
}
assert.notDeepEqual(parseProse("**bold**"), parseProse("__ital__"))
console.log(
  "Worker Markdown pipeline preserves lists, setext, GFM, references, code, citations, escaping, Unicode, incomplete syntax and immutable reuse"
)
