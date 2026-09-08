import { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { XIcon, ExpandIcon } from "lucide-react"
import { readTranscriptMedia } from "@/state/transcript-media"
import { useTranscriptSource } from "./source-context"
import type { AttachmentContent } from "@mako/sessions"
import { previewableMediaUrl } from "@/lib/transcript-media"

type Preview =
  | { kind: "ready"; url: string; mimeType: string }
  | { kind: "error"; message: string }
  | { kind: "loading" }

export function MediaPreview({
  attachment,
}: {
  attachment: AttachmentContent
}) {
  const { threadPath, liveId } = useTranscriptSource()
  const container = useRef<HTMLSpanElement>(null)
  const source = attachment.source
  const path = source.kind === "file" ? source.path : undefined
  const direct =
    source.kind === "inline"
      ? `data:${attachment.mimeType};base64,${source.data}`
      : source.kind === "url"
        ? source.url
        : undefined
  const key = JSON.stringify([path, threadPath, liveId])
  const [resolved, setResolved] = useState<{ key: string; preview: Preview }>()
  const [failedUrl, setFailedUrl] = useState<string>()
  useEffect(() => {
    const element = container.current
    if (!path || !element) return
    let canceled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void readTranscriptMedia({ path, threadPath, liveId }).then(
          (media) => {
            if (!canceled)
              setResolved({ key, preview: { kind: "ready", ...media } })
          },
          (error) => {
            if (!canceled)
              setResolved({
                key,
                preview: {
                  kind: "error",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Preview unavailable",
                },
              })
          }
        )
      },
      { rootMargin: "240px" }
    )
    observer.observe(element)
    return () => {
      canceled = true
      observer.disconnect()
    }
  }, [path, threadPath, liveId, key])
  const preview: Preview = direct
    ? previewableMediaUrl(direct)
      ? { kind: "ready", url: direct, mimeType: attachment.mimeType }
      : { kind: "error", message: "Unsupported preview URL" }
    : resolved?.key === key
      ? resolved.preview
      : { kind: "loading" }
  return (
    <span ref={container} className="transcript-media">
      {preview.kind === "loading" ? (
        <span className="text-ui text-faint">Loading {attachment.name}…</span>
      ) : preview.kind === "error" ? (
        <span className="text-ui text-muted">
          {attachment.name}: {preview.message}
        </span>
      ) : failedUrl === preview.url ? (
        <span className="text-ui text-muted">
          {attachment.name}: preview unavailable
        </span>
      ) : (
        <MediaContent
          name={attachment.name}
          url={preview.url}
          mimeType={preview.mimeType}
          onError={() => setFailedUrl(preview.url)}
        />
      )}
    </span>
  )
}

export function MediaContent({
  name,
  url,
  mimeType,
  onError,
}: {
  name: string
  url: string
  mimeType: string
  onError: () => void
}) {
  if (mimeType.startsWith("audio/"))
    return (
      <audio
        src={url}
        controls
        preload="none"
        aria-label={name}
        onError={onError}
        className="w-full"
      />
    )
  if (mimeType.startsWith("video/"))
    return (
      <video
        src={url}
        controls
        preload="none"
        aria-label={name}
        onError={onError}
        className="max-h-96 max-w-full"
      />
    )
  if (!mimeType.startsWith("image/"))
    return (
      <a href={url} target="_blank" rel="noreferrer">
        Open {name}
      </a>
    )
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="pressable group/media relative block max-w-full rounded border border-hairline"
          aria-label={`Expand ${name}`}
        >
          <img
            src={url}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={onError}
            className="max-h-96 max-w-full object-contain"
          />
          <span className="absolute right-2 bottom-2 rounded bg-raised p-1 text-faint opacity-0 group-hover/media:opacity-100 group-focus-visible/media:opacity-100">
            <ExpandIcon className="size-4" />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100vw-2rem)] p-3">
        <div className="mb-3 flex items-center gap-3">
          <DialogTitle className="min-w-0 flex-1 truncate">{name}</DialogTitle>
          <DialogClose
            className="pressable rounded p-1 text-muted-foreground"
            aria-label="Close preview"
          >
            <XIcon className="size-4" />
          </DialogClose>
        </div>
        <div className="max-h-[80vh] overflow-auto">
          <img
            src={url}
            alt={name}
            className="mx-auto max-h-[78vh] max-w-full object-contain"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
