import assert from "node:assert/strict"
import {
  attachmentReference,
  attachmentRanges,
  editAttachmentReferences,
  restoreAttachmentReferences,
  namedAttachmentReference,
  attachmentPromptSegments,
  reusablePromptAttachments,
} from "../src/lib/attachment-references.ts"
import {
  buildForeignPrompt,
  parseAttachmentAppendix,
  type Attachment,
} from "../src/lib/attachments.ts"
import { SavedAttachmentSchema } from "../src/lib/draft-persistence.ts"

const image: Attachment = {
  id: "image",
  index: 1,
  name: "Screenshot @2x.png",
  reference: "[Screenshot @2x.png]",
  mimeType: "image/png",
  size: 34,
  kind: "image",
  stagedPath: "/retained/nonce-Screenshot @2x.png",
}
const text: Attachment = {
  ...image,
  id: "text",
  index: 2,
  name: "notes.txt",
  reference: "[notes.txt]",
  mimeType: "text/plain",
  kind: "text",
  stagedPath: "/retained/notes.txt",
}
const draft = `Compare ${image.reference} with ${text.reference}.`
const [first, second] = attachmentRanges(draft, [image, text])
assert.ok(first && second)
for (const after of [
  draft.slice(0, first.end - 1) + draft.slice(first.end),
  draft.slice(0, first.start) + draft.slice(first.start + 1),
  draft.slice(0, first.start + 3) + draft.slice(first.end - 3),
]) {
  const edited = editAttachmentReferences(draft, after, [image, text])
  assert.deepEqual(edited.removed, ["image"])
  assert.equal(edited.text, `Compare  with ${text.reference}.`)
  const sent = buildForeignPrompt(edited.text, [text])
  assert.ok(!sent.includes(image.stagedPath!))
  assert.ok(!sent.includes(image.name))
  assert.ok(sent.includes(text.stagedPath!))
}
const replaced = editAttachmentReferences(
  draft,
  draft.slice(0, first.start + 2) + "replacement" + draft.slice(second.end - 2),
  [image, text]
)
assert.equal(replaced.text, "Compare replacement.")
assert.deepEqual(replaced.removed, ["image", "text"])
assert.equal(
  editAttachmentReferences(draft, draft + " More text.", [image, text]).text,
  draft + " More text."
)
assert.equal(
  attachmentReference(SavedAttachmentSchema.parse(image)),
  image.reference
)
assert.equal(
  restoreAttachmentReferences("Look [Attachment 1]", [image]),
  `Look ${image.reference}`
)
assert.equal(
  namedAttachmentReference(image.name, 2, [image.reference!]),
  "[Screenshot @2x.png (2)]"
)

for (const body of [draft, "Compare [Attachment 1] with [Attachment 2]."]) {
  const parsed = parseAttachmentAppendix(
    buildForeignPrompt(body, [image, text])
  )
  const segments = attachmentPromptSegments(parsed.body, parsed.files)
  assert.deepEqual(
    segments
      .filter((part) => part.kind === "attachment")
      .map((part) => part.file.name),
    [image.name, text.name]
  )
  assert.ok(
    !segments.some(
      (part) => part.kind === "text" && part.text.includes("[Attachment")
    )
  )
  const reusable = reusablePromptAttachments(parsed.files, [])
  assert.equal(reusable[0]?.name, image.name)
  assert.equal(reusable[0]?.mimeType, "image/png")
  assert.equal(reusable[0]?.stagedPath, image.stagedPath)
  assert.ok(
    buildForeignPrompt(
      restoreAttachmentReferences(parsed.body, reusable),
      reusable
    ).includes(image.stagedPath!)
  )
}
console.log(
  "Inline attachment edits, deletion payloads, filename collisions, saved drafts, legacy transcript rendering, and reuse passed"
)

const onlyFiles = parseAttachmentAppendix(buildForeignPrompt("", [image]))
assert.equal(onlyFiles.body, "")
assert.equal(onlyFiles.files[0]?.name, image.name)
assert.equal(
  restoreAttachmentReferences("Paragraph", [image]),
  `Paragraph\n${image.reference}`
)
