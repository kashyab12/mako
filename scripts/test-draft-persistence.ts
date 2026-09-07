import assert from "node:assert/strict"
import {
  readAttachmentDrafts,
  writeAttachmentDrafts,
} from "../src/lib/draft-persistence.ts"
const saved = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  },
})
const { rememberDraft, draftText, retainRejectedDraft } =
  await import("../src/state/drafts.ts")
for (let index = 0; index < 100; index++)
  rememberDraft(`session-${index}`, `paragraph ${index}`)
assert.equal(
  draftText("session-0"),
  "paragraph 0",
  "opening many sessions must not delete drafts"
)
assert.ok(saved.get("mako.session-drafts.v1")?.includes("paragraph 0"))
const attachment = {
  id: "file",
  index: 3,
  name: "plot.png",
  mimeType: "image/png",
  size: 100,
  kind: "image" as const,
  stagedPath: "/retained/plot.png",
  preview: "blob:expired-on-reload",
  data: "unnecessary-large-base64",
}
writeAttachmentDrafts({
  session: [attachment],
  pending: [{ ...attachment, stagedPath: undefined, pending: true }],
})
const restored = readAttachmentDrafts()
assert.equal(restored.session?.[0]?.stagedPath, attachment.stagedPath)
assert.equal(restored.session?.[0]?.preview, undefined)
assert.equal(restored.session?.[0]?.data, undefined)
assert.match(restored.pending?.[0]?.error ?? "", /not fully staged/)
retainRejectedDraft("session-1", "rejected paragraph", [attachment])
assert.ok(saved.get("mako.session-drafts.v1")?.includes("rejected paragraph"))
assert.ok(!saved.get("mako.session-drafts.v1")?.includes("blob:"))
console.log(
  "Draft text, rejected sends, staged attachments, and incomplete staging persist without the old 64-session loss limit"
)
