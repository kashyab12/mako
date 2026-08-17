import { lazy, Suspense, useEffect } from "react"
import { IconAction } from "@/components/ui/kit"
import { getPi } from "@/lib/bridge"
import { viewer, useViewer } from "@/state/viewer"
import { cn } from "@/lib/utils"
import { AtSignIcon, ExternalLinkIcon, RefreshCwIcon, XIcon } from "lucide-react"

/** The highlighting runtime is heavy and nobody has opened a file yet. */
const View = lazy(() =>
  import("@/components/viewer/file-view").then((module) => ({ default: module.FileView }))
)

/**
 * The open file.
 *
 * Takes the transcript's space rather than floating over it. A modal would
 * dim the conversation you are reading the file *because of*, and a split
 * would halve both. Escape gives the space back, and the conversation is
 * exactly where you left it because nothing about it unmounted — only this
 * layer did.
 */
export function FileViewer() {
  const path = useViewer((state) => state.path)
  const file = useViewer((state) => state.file)
  const loading = useViewer((state) => state.loading)
  const error = useViewer((state) => state.error)

  useEffect(() => {
    if (!path) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        viewer.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [path])

  if (!path) return null

  return (
    <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
          {path}
        </span>
        {file?.truncated ? (
          <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10px] text-caution">
            first 2 MB
          </span>
        ) : null}
        <IconAction
          label="Mention this file in the composer"
          size="xs"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("pi:insert", { detail: `@${path} ` }))
            viewer.close()
          }}
        >
          <AtSignIcon />
        </IconAction>
        <IconAction label="Re-read from disk" size="xs" onClick={() => viewer.refresh()}>
          <RefreshCwIcon />
        </IconAction>
        <IconAction
          label="Open in your editor"
          size="xs"
          onClick={() => void getPi().revealPath(path)}
        >
          <ExternalLinkIcon />
        </IconAction>
        <IconAction label="Close" keys={["Esc"]} size="xs" onClick={() => viewer.close()}>
          <XIcon />
        </IconAction>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-auto", loading && "opacity-60")}>
        {error ? (
          <p className="p-4 text-[12px] text-removed">{error}</p>
        ) : file ? (
          <Suspense fallback={<p className="shimmer p-4 text-[12px]">Opening…</p>}>
            <View file={file} />
          </Suspense>
        ) : (
          <p className="shimmer p-4 text-[12px]">Reading {path}…</p>
        )}
      </div>
    </div>
  )
}

