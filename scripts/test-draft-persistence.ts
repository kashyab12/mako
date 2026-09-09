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

writeAttachmentDrafts({
  "task-a": [
    {
      ...attachment,
      name: "Appshot A.png",
      contextPath: "/retained/a.context.txt",
    },
  ],
  "task-b": [
    {
      ...attachment,
      id: "file-b",
      name: "Appshot B.png",
      stagedPath: "/retained/b.png",
      contextPath: "/retained/b.context.txt",
    },
  ],
})
const appshots = readAttachmentDrafts()
assert.equal(appshots["task-a"]?.[0]?.contextPath, "/retained/a.context.txt")
assert.equal(appshots["task-b"]?.[0]?.stagedPath, "/retained/b.png")
assert.equal(appshots["task-a"]?.length, 1)
assert.equal(appshots["task-b"]?.length, 1)
console.log(
  "Appshot image and context paths restore as one attachment independently for each task"
)

const { clearSubmittedDraft } = await import("../src/state/drafts.ts")
rememberDraft("delegation:one", "original task")
rememberDraft("delegation:two", "other conversation")
rememberDraft("delegation:one", "new task typed before acceptance")
clearSubmittedDraft("delegation:one", "original task")
assert.equal(draftText("delegation:one"), "new task typed before acceptance")
assert.equal(draftText("delegation:two"), "other conversation")
clearSubmittedDraft("delegation:one", "new task typed before acceptance")
assert.equal(draftText("delegation:one"), "")
assert.equal(draftText("delegation:two"), "other conversation")
assert.ok(saved.get("mako.session-drafts.v1")?.includes("other conversation"))
console.log(
  "Delegation drafts persist per conversation; late acceptance preserves newer text"
)
