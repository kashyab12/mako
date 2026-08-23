import { cn } from "@/lib/utils"
import { formatBytes, type Attachment } from "@/lib/attachments"
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileTextIcon,
  FileVideoIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react"
import type { ComponentType } from "react"

/**
 * The attached files, numbered to match the `[Attachment N]` markers sitting
 * in the draft. The number is the whole point: it is what lets a sentence say
 * "compare 1 with 2" and have the agent know which is which.
 */
export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: Attachment[]
  onRemove: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
      {items.map((item) => (
        <Card key={item.id} item={item} onRemove={onRemove} />
      ))}
    </div>
  )
}

function Card({ item, onRemove }: { item: Attachment; onRemove: (id: string) => void }) {
  return (
    <div
      title={`Attachment ${item.index} · ${item.name} · ${formatBytes(item.size)}`}
      className={cn(
        "group relative flex h-14 items-center gap-2 overflow-hidden rounded-lg",
        "bg-raised pr-2.5 ring-1 ring-hairline backdrop-blur-sm",
        item.pending && "opacity-70"
      )}
    >
      {item.preview ? (
        <img src={item.preview} alt={item.name} className="h-full w-14 shrink-0 object-cover" />
      ) : (
        <span className="flex h-full w-11 shrink-0 items-center justify-center bg-surface/60 text-faint">
          <Glyph item={item} />
        </span>
      )}

      <span className="flex min-w-0 flex-col pr-3">
        <span className="tabular text-label text-faint">Attachment {item.index}</span>
        <span className="max-w-[10rem] truncate text-ui text-foreground/85">{item.name}</span>
        <span className="text-label text-faint">
          {item.pending ? "reading…" : formatBytes(item.size)}
        </span>
      </span>

      <button
        type="button"
        aria-label={`Remove attachment ${item.index}`}
        onClick={() => onRemove(item.id)}
        className={cn(
          "absolute top-1 right-1 flex size-4 items-center justify-center rounded",
          "bg-background/70 text-foreground opacity-0 transition-opacity duration-150",
          "group-hover:opacity-100 focus-visible:opacity-100"
        )}
      >
        <XIcon className="size-2.5" />
      </button>
    </div>
  )
}

/** Picking the glyph inside a component keeps the element type stable. */
function Glyph({ item }: { item: Attachment }) {
  const Icon: ComponentType<{ className?: string }> = item.mimeType.startsWith("video/")
    ? FileVideoIcon
    : item.mimeType.startsWith("audio/")
      ? FileAudioIcon
      : /zip|tar|gzip|compressed/.test(item.mimeType)
        ? FileArchiveIcon
        : item.kind === "text" || item.mimeType === "application/pdf"
          ? FileTextIcon
          : PaperclipIcon
  return <Icon className="size-4" />
}
