import { useCallback, useEffect, useRef, useState } from "react"
import { getPi } from "@/lib/bridge"
import { toast } from "sonner"

/**
 * Attachments.
 *
 * Anything can be attached. What differs is how it reaches the agent:
 *
 *   image  → inline, through Pi's `images` field
 *   text   → inlined into the prompt as a labelled block
 *   binary → written to a scratch file, with the path handed over so Pi's
 *            own read and bash tools can open it
 *
 * A PDF or a video therefore attaches like anything else and stays reachable,
 * rather than being refused for not fitting the model's inline contract.
 *
 * In the draft the attachment appears as `[Attachment 2]` at the caret, so its
 * position in the sentence is preserved — "compare [Attachment 1] with
 * [Attachment 2]" means something the model can follow — while the file itself
 * shows as a numbered preview above the composer.
 */

export type AttachmentKind = "image" | "text" | "binary"

export interface Attachment {
  id: string
  /** 1-based, matching the `[Attachment N]` marker in the draft. */
  index: number
  name: string
  mimeType: string
  size: number
  kind: AttachmentKind
  /** Base64, for images. */
  data?: string
  /** Decoded contents, for text-ish files. */
  text?: string
  /** Object URL, for image thumbnails. */
  preview?: string
  /** Scratch-file path, for anything the model cannot take inline. */
  stagedPath?: string
  /** True while the file is being read or staged. */
  pending?: boolean
}

const MAX_INLINE_TEXT = 200_000
const MAX_BYTES = 256 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "rst", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "env",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "rb", "java", "kt", "swift", "c", "h",
  "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "html", "css", "scss", "svg", "xml",
  "patch", "diff", "log", "lock", "gradle", "make", "dockerfile",
])

export function classify(file: File): AttachmentKind {
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") return "image"
  const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return "text"
  if (file.type === "application/json" || file.type === "application/xml") return "text"
  return "binary"
}

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([])
  const nextIndex = useRef(1)

  // Object URLs leak if the composer unmounts mid-draft. The mirror is written
  // in an effect so the unmount cleanup can read it without touching a ref
  // during render.
  const live = useRef<Attachment[]>([])
  useEffect(() => {
    live.current = items
  }, [items])
  useEffect(() => {
    return () => {
      for (const item of live.current) {
        if (item.preview) URL.revokeObjectURL(item.preview)
      }
    }
  }, [])

  /** Returns the markers to insert, so the caller can place them at the caret. */
  const add = useCallback(async (files: File[]): Promise<string> => {
    const accepted: Attachment[] = []

    for (const file of files) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is larger than 256 MB`)
        continue
      }
      const kind = classify(file)
      accepted.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${nextIndex.current}`,
        index: nextIndex.current++,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind,
        preview: kind === "image" ? URL.createObjectURL(file) : undefined,
        pending: true,
      })
    }
    if (accepted.length === 0) return ""

    setItems((current) => [...current, ...accepted])

    // Reading and staging happen after the chips are on screen, so a large
    // file never delays the acknowledgement that it was accepted.
    void Promise.all(
      accepted.map(async (attachment, offset) => {
        const file = files[files.length - accepted.length + offset]
        try {
          const resolved = await resolve(attachment, file)
          setItems((current) =>
            current.map((item) => (item.id === attachment.id ? resolved : item))
          )
        } catch (error) {
          toast.error(
            `Could not attach ${attachment.name}: ${error instanceof Error ? error.message : error}`
          )
          setItems((current) => current.filter((item) => item.id !== attachment.id))
        }
      })
    )

    return accepted.map((item) => `[Attachment ${item.index}]`).join(" ")
  }, [])

  /**
   * Resolves when no attachment is still reading or staging — the moment a
   * prompt that references them can actually be sent. Sending earlier is
   * how a message once went out with a dead [Attachment 1] marker and no
   * file behind it.
   */
  const settled = useCallback(async (): Promise<Attachment[]> => {
    const deadline = Date.now() + 20_000
    while (live.current.some((item) => item.pending) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return live.current
  }, [])

  const remove = useCallback((id: string) => {
    setItems((current) => {
      const found = current.find((item) => item.id === id)
      if (found?.preview) URL.revokeObjectURL(found.preview)
      return current.filter((item) => item.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    setItems((current) => {
      for (const item of current) if (item.preview) URL.revokeObjectURL(item.preview)
      return []
    })
    nextIndex.current = 1
  }, [])

  /**
   * Take the attachments off the composer *without* destroying them.
   *
   * Sending clears the composer before the host has accepted anything, so it
   * feels instant. That is only safe if a rejected send can put everything
   * back — and `clear` revokes the preview URLs, which would restore a strip
   * of broken images. These three let the caller hold the items until it knows
   * which way it went.
   */
  const detach = useCallback((): Attachment[] => {
    const taken = live.current
    setItems([])
    return taken
  }, [])

  const reattach = useCallback((taken: Attachment[]) => {
    setItems(taken)
  }, [])

  const discard = useCallback((taken: Attachment[]) => {
    for (const item of taken) if (item.preview) URL.revokeObjectURL(item.preview)
    nextIndex.current = 1
  }, [])

  return { items, add, remove, clear, detach, reattach, discard, settled }
}

async function resolve(attachment: Attachment, file: File): Promise<Attachment> {
  if (attachment.kind === "image") {
    return { ...attachment, data: await toBase64(file), pending: false }
  }
  if (attachment.kind === "text") {
    const text = await file.text()
    return {
      ...attachment,
      text: text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n… truncated …` : text,
      pending: false,
    }
  }
  // The fast lane: a dropped or picked file has an OS path, and staging is
  // then one filesystem copy in the engine — nothing crosses the IPC
  // boundary. Base64 marshalling is only the fallback for files that truly
  // have no path (a paste from another app's clipboard).
  const sourcePath = getPi().pathForFile?.(file) ?? null
  if (sourcePath) {
    const staged = await getPi().stageFilePath(sourcePath)
    return { ...attachment, stagedPath: staged.path, pending: false }
  }
  const staged = await getPi().stageFile(file.name, await toBase64(file))
  return { ...attachment, stagedPath: staged.path, pending: false }
}

/**
 * The browser's own encoder, off the main thread — not a fromCharCode loop
 * that freezes the composer for the length of a video.
 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => {
      const url = reader.result as string
      resolve(url.slice(url.indexOf(",") + 1))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Assemble what actually gets sent. The draft keeps its `[Attachment N]`
 * markers so the model can tell which one a sentence refers to, and an
 * appendix explains what each marker is.
 */
export function buildPrompt(
  draft: string,
  items: Attachment[]
): { text: string; images: Array<{ mimeType: string; data: string }> } {
  const images: Array<{ mimeType: string; data: string }> = []
  const appendix: string[] = []

  for (const item of items) {
    if (item.kind === "image" && item.data) {
      images.push({ mimeType: item.mimeType, data: item.data })
      appendix.push(`[Attachment ${item.index}] ${item.name} — image, attached inline above.`)
      continue
    }
    if (item.kind === "text" && item.text !== undefined) {
      appendix.push(
        `[Attachment ${item.index}] ${item.name}\n\`\`\`\n${item.text}\n\`\`\``
      )
      continue
    }
    if (item.stagedPath) {
      appendix.push(
        `[Attachment ${item.index}] ${item.name} — ${item.mimeType}, ${formatBytes(item.size)}. ` +
          `Saved at ${item.stagedPath}; read it from there if you need its contents.`
      )
    }
  }

  if (appendix.length === 0) return { text: draft, images }
  const body = draft.trim()
  return {
    text: `${body}${body ? "\n\n" : ""}---\n${appendix.join("\n\n")}`,
    images,
  }
}

/**
 * The prompt for a harness reached through its CLI: no inline images, so
 * every attachment — image included — resolves to its staged file, and the
 * [Attachment N] markers the draft carries point at real paths the agent
 * can open. Anything still unstaged is named honestly as unavailable
 * rather than silently dropped.
 */
export function buildForeignPrompt(draft: string, items: Attachment[]): string {
  const appendix: string[] = []
  for (const item of items) {
    if (item.stagedPath) {
      appendix.push(
        `[Attachment ${item.index}] ${item.name} — ${item.mimeType}, ${formatBytes(item.size)}. ` +
          `Saved at ${item.stagedPath}; read it from there.`
      )
    } else if (item.kind === "text" && item.text !== undefined) {
      appendix.push(`[Attachment ${item.index}] ${item.name}
\`\`\`
${item.text}
\`\`\``)
    } else {
      appendix.push(`[Attachment ${item.index}] ${item.name} — could not be staged; ask for it again.`)
    }
  }
  if (appendix.length === 0) return draft
  const body = draft.trim()
  return `${body}${body ? "\n\n" : ""}---\n${appendix.join("\n\n")}`
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
