import assert from "node:assert/strict"
import { clipboardSelection, parsePromptClipboard, promptClipboard } from "../src/lib/prompt-clipboard.ts"
import { attachmentRanges, attachmentReference, pasteAttachmentDraft } from "../src/lib/attachment-references.ts"
import { buildForeignPrompt, type Attachment } from "../src/lib/attachments.ts"

const image: Attachment = {
  id: "screenshot", index: 1, name: "Screenshot [today].png", reference: "[Screenshot [today].png]",
  mimeType: "image/png", kind: "image", size: 120,
  stagedPath: "/retained/screenshot.png", contextPath: "/retained/screenshot.context.txt",
  preview: "blob:expired-after-copy", data: "must-not-be-copied", text: "must-not-be-copied",
}
const file: Attachment = { id: "notes", index: 2, name: "notes.txt", reference: "[notes.txt]", mimeType: "text/plain", kind: "text", size: 10, stagedPath: "/retained/notes.txt" }
const text = `  Compare ${image.reference}\nwith ${file.reference} @src/index.css @thread:claude:native-id #review\n`
const payload = promptClipboard(text, [image, file])
const restored = parsePromptClipboard(payload.text, payload.html)
assert.ok(restored)
assert.equal(restored.text, text)
assert.deepEqual(restored.attachments.map(item => item.stagedPath), [image.stagedPath, file.stagedPath])
assert.equal(restored.attachments[0]?.contextPath, image.contextPath)
assert.ok(!payload.html.includes("must-not-be-copied"))
assert.ok(!payload.html.includes("blob:"))
assert.ok(!restored.attachments[0]?.preview)
assert.ok(!restored.attachments[0]?.data)
const plain = parsePromptClipboard(payload.text)
assert.ok(plain)
assert.deepEqual(plain.attachments.map(item => item.mimeType), ["image/png", "text/plain"])
assert.equal(plain.attachments[0]?.contextPath, image.contextPath)
assert.ok(!plain.text.includes("Window text saved at"))
assert.ok(!plain.text.includes("Saved at"))
assert.equal(parsePromptClipboard("Just [a label] @src/a.ts"), null)
assert.equal(parsePromptClipboard("Hello", '<pre data-mako-draft="%broken">Hello</pre>'), null)
assert.equal(parsePromptClipboard("Hello", `<pre data-mako-draft="${encodeURIComponent(JSON.stringify({ version: 2, text: "bad", attachments: [] }))}">Hello</pre>`), null)
assert.throws(() => promptClipboard(text, [{ ...image, pending: true }]), /finish adding/)
assert.throws(() => promptClipboard(text, [{ ...image, stagedPath: undefined }]), /finish adding/)
assert.throws(() => promptClipboard(text, [{ ...image, error: "missing" }]), /finish adding/)
assert.throws(() => promptClipboard(text, [image, { ...image, stagedPath: "/different.png" }]))
assert.deepEqual(parsePromptClipboard(payload.text, '<pre data-mako-draft="%broken">Hello</pre>'), plain)
const markup = promptClipboard('<tag> & "quoted"', [])
assert.ok(markup.html.includes('&lt;tag&gt; &amp; "quoted"'))
assert.equal(parsePromptClipboard(markup.text, markup.html)?.text, '<tag> & "quoted"')

const imageRange = attachmentRanges(text, [image, file])[0]!
const selected = clipboardSelection(text, [image, file], imageRange.start + 2, imageRange.end - 1)
assert.equal(selected.text, image.reference)
assert.deepEqual(selected.attachments, [image])
assert.equal(selected.start, imageRange.start)
assert.equal(selected.end, imageRange.end)
assert.equal(clipboardSelection(text, [image, file], 0, 2).attachments.length, 0)

const collision = { ...image, id: "other-screenshot", stagedPath: "/other/screenshot.png" }
const pasted = pasteAttachmentDraft(restored.text, restored.attachments, [collision])
assert.notEqual(pasted.attachments[0]?.reference, collision.reference)
assert.notEqual(pasted.attachments[0]?.id, image.id)
assert.deepEqual(attachmentRanges(pasted.text, pasted.attachments).map(range => range.item.stagedPath), [image.stagedPath, file.stagedPath])
const again = pasteAttachmentDraft(restored.text, restored.attachments, [collision, ...pasted.attachments])
assert.equal(new Set([collision, ...pasted.attachments, ...again.attachments].map(attachmentReference)).size, 5)
const repeatedCopy = promptClipboard(`${pasted.text}\n${again.text}`, [...pasted.attachments, ...again.attachments])
const repeatedPlain = parsePromptClipboard(repeatedCopy.text)
assert.ok(repeatedPlain)
assert.equal(repeatedPlain.attachments.length, 4, "Repeated references to the same staged file retain each marker identity")
assert.equal(attachmentRanges(repeatedPlain.text, repeatedPlain.attachments).length, 4)
assert.ok(!repeatedPlain.text.includes("[Attachment "))
assert.ok(buildForeignPrompt(pasted.text, pasted.attachments).includes(image.contextPath!))
assert.ok(buildForeignPrompt(pasted.text, pasted.attachments).includes(image.stagedPath!))
console.log("PASS: clipboard metadata, plain-text fallback, window context, atomic selection, collision remapping, malformed input, and pending-file rejection")
