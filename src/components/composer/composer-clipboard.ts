import { useRef, type ClipboardEvent } from "react"
import { attachmentRanges, editAttachmentReferences } from "@/lib/attachment-references"
import { toast } from "sonner"
import type { useAttachments } from "@/lib/attachments"
import { clipboardSelection, parsePromptClipboard, promptClipboard } from "@/lib/prompt-clipboard"

export function useComposerClipboard(attachments: ReturnType<typeof useAttachments>) {
  const inserting = useRef(false)
  const insert = (text: string) => {
    inserting.current = true
    try {
      document.execCommand("insertText", false, text)
    } finally {
      inserting.current = false
    }
  }
  const edit = (before: string, after: string, inputType: string) => {
    if (!inserting.current && inputType !== "historyUndo" && inputType !== "historyRedo") return editAttachmentReferences(before, after, attachments.items)
    const present = new Set(attachmentRanges(after, attachments.items).map(range => range.item.id))
    return { text: after, removed: attachments.items.filter(item => !present.has(item.id)).map(item => item.id), caret: after.length }
  }
  const copy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const node = event.currentTarget
    if (node.selectionStart === node.selectionEnd) return
    const selected = clipboardSelection(node.value, attachments.items, node.selectionStart, node.selectionEnd)
    if (!selected.attachments.length) return
    event.preventDefault()
    try {
      const payload = promptClipboard(selected.text, selected.attachments)
      event.clipboardData.setData("text/plain", payload.text)
      event.clipboardData.setData("text/html", payload.html)
      if (event.type === "cut") {
        node.setSelectionRange(selected.start, selected.end)
        insert("")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData
    const text = data.getData("text/plain")
    const draft = parsePromptClipboard(text, data.getData("text/html"))
    const files = [...data.files]
    if (!draft && !files.length) return
    event.preventDefault()
    const node = event.currentTarget
    const selected = clipboardSelection(node.value, attachments.items, node.selectionStart, node.selectionEnd)
    node.setSelectionRange(selected.start, selected.end)
    const insertion = draft
      ? attachments.paste(draft.text, draft.attachments)
      : [text, attachments.add(files)].filter(Boolean).join(text.endsWith(" ") || text.endsWith("\n") ? "" : " ")
    insert(insertion)
  }
  return { onCopy: copy, onCut: copy, onPaste: paste, edit }
}
