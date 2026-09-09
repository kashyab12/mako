import type { AttachmentContent } from "@mako/sessions"
import { attachmentFromUrl } from "@mako/sessions/content"
import { markdownFileTarget } from "./file-citations"

const mediaTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["svg", "image/svg+xml"],
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["m4a", "audio/mp4"],
  ["ogg", "audio/ogg"],
  ["flac", "audio/flac"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["pdf", "application/pdf"],
])

export function mediaTypeForPath(path: string): string | undefined {
  return mediaTypes.get(path.split(/[?#]/)[0]?.split(".").at(-1)?.toLowerCase() ?? "")
}

export function markdownMedia(
  source: string,
  label?: string
): AttachmentContent {
  const file = markdownFileTarget(source)
  const pathname = file?.path ?? source.split(/[?#]/)[0] ?? source
  const name = label || pathname.split("/").at(-1) || "Attachment"
  const mimeType =
    /^data:([^;,]+)/i.exec(source)?.[1] ??
    mediaTypeForPath(pathname) ??
    "image/png"
  return file
    ? {
        type: "attachment",
        name,
        mimeType,
        source: { kind: "file", path: file.path },
      }
    : attachmentFromUrl(name, mimeType, source)
}

export function previewableMediaUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) ||
    /^data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,/i.test(url)
  )
}
