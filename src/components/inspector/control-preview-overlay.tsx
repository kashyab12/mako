import { useEffect } from "react"
import { GlobeIcon, MonitorIcon, SquareIcon, XIcon } from "lucide-react"
import {
  hideControlPreview,
  observeControlPreview,
  stopControlTask,
  useControlPreview,
  watchControlPreview,
} from "@/state/control-preview"

export function ControlPreviewOverlay({
  initialConversationId,
}: {
  initialConversationId: string
}) {
  const id = useControlPreview(
    (state) => state.latestActivity?.conversationId ?? initialConversationId
  )
  const preview = useControlPreview((state) =>
    state.conversationId === id ? state.preview : null
  )
  useEffect(observeControlPreview, [])
  useEffect(() => watchControlPreview(id), [id])
  const frame = preview?.frame
  const activity = preview?.activity
  return (
    <section
      aria-label="Live control preview"
      className="group flex h-screen flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground"
    >
      <div className="drag-region relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background">
        {frame && (
          <img
            src={`data:${frame.image.mimeType};base64,${frame.image.data}`}
            alt="Live view of the window this task is using"
            className="h-full w-full object-contain"
            decoding="async"
          />
        )}
        <button
          type="button"
          aria-label="Hide preview"
          onClick={() => void hideControlPreview()}
          className="no-drag pressable absolute top-2 right-2 flex size-6 items-center justify-center rounded-full border border-hairline bg-popover/90 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="drag-region flex h-9 shrink-0 items-center gap-2 border-t border-hairline px-2.5 text-label">
        {activity?.kind === "browser" ? (
          <GlobeIcon className="size-3.5 text-muted-foreground" />
        ) : (
          <MonitorIcon className="size-3.5 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {activity?.kind === "browser" ? "Browser" : "Computer"}
          {activity ? ` · ${activity.operation.replaceAll("_", " ")}` : ""}
        </span>
        {activity?.status === "running" ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-ember"
            aria-label="Working"
          />
        ) : (
          <span className="shrink-0 text-faint">
            {activity?.status === "error" ? "Action failed" : "Latest view"}
          </span>
        )}
        <button
          type="button"
          aria-label="Stop task"
          onClick={() => void stopControlTask(id)}
          className="no-drag pressable flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-fill-hover hover:text-foreground"
          title="Stop task"
        >
          <SquareIcon className="size-2.5 fill-current" />
        </button>
      </div>
    </section>
  )
}
