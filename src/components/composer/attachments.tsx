import { XIcon } from "lucide-react"
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

/**
 * Images stay visible while the draft is written. The inline chip keeps the
 * textarea's glyph-for-glyph overlay honest, so it can only show text; the
 * thumbnail row above it is where the screenshot is actually seen.
 */
export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: Attachment[]
  onRemove(id: string): void
}) {
  const images = items.filter((item) => item.kind === "image")
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {images.map((item) => (
        <Thumbnail key={item.id} item={item} onRemove={onRemove} />
      ))}
    </div>
  )
}

function Thumbnail({
  item,
  onRemove,
}: {
  item: Attachment
  onRemove(id: string): void
}) {
  const preview = useAttachmentPreview(item)
  return (
    <span
      title={`${item.name} · ${item.pending ? "Adding…" : formatBytes(item.size)}`}
      className={cn("group relative shrink-0", item.pending && "opacity-60")}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Preview ${item.name}`}
            className="pressable relative block h-16 w-20 overflow-hidden rounded-md border border-border bg-background focus-visible:outline focus-visible:outline-ring"
          >
            {preview ? (
              <img
                src={preview}
                alt={item.name}
                className="h-full w-full object-cover"
                decoding="async"
              />
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(36rem,calc(100vw-2rem))] overflow-hidden p-0"
        >
          {preview ? (
            <img
              src={preview}
              alt={item.name}
              className="max-h-[60vh] w-full bg-background object-contain"
              decoding="async"
            />
          ) : null}
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
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onRemove(item.id)}
        className="pressable absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-ring"
      >
        <XIcon className="size-2.5" />
      </button>
    </span>
  )
}

export function InlineAttachment({
  item,
  reference,
  onRemove,
}: {
  item: Attachment
  reference: string
  onRemove(id: string): void
}) {
  const preview = useAttachmentPreview(item)
  return (
    <span
      data-attachment-reference
      title={
        item.error ??
        `${item.name} · ${item.pending ? "Adding…" : item.size ? formatBytes(item.size) : item.mimeType}`
      }
      className={cn(
        "rounded bg-fill-selected [box-decoration-break:clone] text-foreground ring-1 ring-border ring-inset",
        item.pending && "opacity-60",
        item.error && "text-negative"
      )}
    >
      <Popover>
        <PopoverTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-label={`Preview ${item.name}`}
            className="pressable pointer-events-auto relative z-10 rounded text-left hover:bg-fill-hover focus-visible:outline focus-visible:outline-ring"
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                event.currentTarget.click()
              }
              if (event.key === "Backspace" || event.key === "Delete") {
                event.preventDefault()
                onRemove(item.id)
              }
            }}
          >
            {reference.slice(0, -1)}
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden p-0"
        >
          {preview ? (
            <img
              src={preview}
              alt={item.name}
              className="max-h-72 w-full object-contain"
            />
          ) : null}
          <div className="px-3 py-2 text-ui">
            <p className="break-words">{item.name}</p>
            <p className="text-label text-muted-foreground">
              {item.error ??
                (item.pending
                  ? "Adding…"
                  : item.size
                    ? formatBytes(item.size)
                    : item.mimeType)}
            </p>
          </div>
        </PopoverContent>
      </Popover>
      <span className="relative">
        <span aria-hidden className="invisible">
          {reference.slice(-1)}
        </span>
        <button
          type="button"
          aria-label={`Remove ${item.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRemove(item.id)}
          onKeyDown={(event) => {
            if (event.key === "Backspace" || event.key === "Delete") {
              event.preventDefault()
              onRemove(item.id)
            }
          }}
          className="pressable pointer-events-auto absolute -top-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
        >
          <XIcon className="size-2.5" />
        </button>
      </span>
    </span>
  )
}
