import { cn } from "@/lib/utils"
import {
  formatBytes,
  useAttachmentPreview,
  type Attachment,
} from "@/lib/attachments"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react"
import type { ComponentType } from "react"

export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: Attachment[]
  onRemove: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((item) => (
        <Card key={item.id} item={item} onRemove={onRemove} />
      ))}
    </div>
  )
}

function Card({
  item,
  onRemove,
}: {
  item: Attachment
  onRemove: (id: string) => void
}) {
  const preview = useAttachmentPreview(item)
  const image = item.kind === "image"
  return (
    <div
      title={`Attachment ${item.index} · ${item.name} · ${formatBytes(item.size)}`}
      className={cn("group relative shrink-0", item.pending && "opacity-70")}
    >
      {image && preview ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Preview attachment ${item.index}: ${item.name}`}
              className="pressable relative block h-20 w-24 overflow-hidden rounded-xl border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src={preview}
                alt={item.name}
                className="h-full w-full object-contain"
                decoding="async"
              />
              <span className="absolute bottom-1 left-1 rounded bg-background/85 px-1 text-label text-muted-foreground">
                {item.index}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={12}
            className="w-[min(36rem,calc(100vw-2rem))] gap-0 overflow-hidden rounded-xl border border-border p-0"
          >
            <img
              src={preview}
              alt={item.name}
              className="max-h-[60vh] w-full bg-background object-contain"
              decoding="async"
            />
            <div className="flex min-w-0 items-center gap-3 border-t border-hairline px-3 py-2 text-label text-muted-foreground">
              <span className="truncate">{item.name}</span>
              <span className="ml-auto shrink-0">
                {item.contextPath || item.context
                  ? "Image + window text"
                  : formatBytes(item.size)}
              </span>
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <div className="flex h-16 max-w-64 items-center gap-2 rounded-lg border border-border bg-raised px-3 pr-7">
          <span className="shrink-0 text-faint">
            {image ? <ImageIcon className="size-4" /> : <Glyph item={item} />}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-ui text-foreground/85">
              {item.name}
            </span>
            <span className="text-label text-faint">
              {item.error ??
                (item.pending
                  ? "Adding…"
                  : `Attachment ${item.index} · ${formatBytes(item.size)}`)}
            </span>
          </span>
        </div>
      )}
      <button
        type="button"
        aria-label={`Remove attachment ${item.index}`}
        onClick={() => onRemove(item.id)}
        className="pressable absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
      {item.error && image && preview && (
        <span
          role="status"
          className="mt-1 block max-w-40 text-label text-negative"
        >
          {item.error}
        </span>
      )}
    </div>
  )
}

function Glyph({ item }: { item: Attachment }) {
  const Icon: ComponentType<{ className?: string }> = item.mimeType.startsWith(
    "video/"
  )
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
