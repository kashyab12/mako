import { useEffect, useRef, useState } from "react"
import { GlobeIcon, MonitorIcon, SquareIcon, XIcon } from "lucide-react"
import {
  hideControlPreview,
  controlPreviewStream,
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
  const nativeWindow = preview?.window
  return (
    <section
      aria-label="Live control preview"
      className="group flex h-screen flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground"
    >
      <div className="drag-region relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background">
        {nativeWindow ? (
          <NativePreview
            key={`${id}:${nativeWindow.pid}:${nativeWindow.windowId}`}
            id={id}
            poster={
              frame
                ? `data:${frame.image.mimeType};base64,${frame.image.data}`
                : undefined
            }
          />
        ) : (
          frame && (
            <img
              src={`data:${frame.image.mimeType};base64,${frame.image.data}`}
              alt="Live view of the window this task is using"
              className="h-full w-full object-contain"
              decoding="async"
            />
          )
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

function NativePreview({ id, poster }: { id: string; poster?: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let closed = false
    let stream: MediaStream | null = null
    void controlPreviewStream(id)
      .then(async (value) => {
        if (closed) {
          value?.getTracks().forEach((track) => track.stop())
          return
        }
        stream = value
        const element = video.current
        if (!stream || !element) {
          setFailed(true)
          return
        }
        element.srcObject = stream
        await element.play()
      })
      .catch(() => {
        if (!closed) setFailed(true)
      })
    return () => {
      closed = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [id])
  return (
    <>
      <video
        ref={video}
        muted
        autoPlay
        playsInline
        poster={poster}
        aria-label="Live application window"
        className="h-full w-full object-contain"
      />
      {failed && (
        <span
          role="status"
          className="absolute bottom-2 left-2 rounded bg-popover/90 px-2 py-1 text-label text-muted-foreground"
        >
          Live preview unavailable{poster ? " · Latest screenshot" : ""}
        </span>
      )}
    </>
  )
}
