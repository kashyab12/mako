import { useEffect, useRef, useState } from "react"
import { GlobeIcon, MonitorIcon, SquareIcon, XIcon } from "lucide-react"
import {
  controlPreviewStream,
  stopControlTask,
  useControlPreview,
  watchControlPreview,
} from "@/state/control-preview"

/** The containing timeline owns its position; this never creates a system window or portal. */
export function ControlPreviewOverlay({
  conversationId,
}: {
  conversationId?: string
}) {
  return conversationId ? (
    <TaskPreview key={conversationId} id={conversationId} />
  ) : null
}

function TaskPreview({ id }: { id: string }) {
  const activity = useControlPreview((state) => state.activities[id])
  const [collapsed, setCollapsed] = useState(false)
  const boundary = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const node = boundary.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false)
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={boundary}
      data-control-preview-task={id}
      className="pointer-events-none absolute top-4 right-4 z-20 min-h-px w-72 max-w-[calc(100%_-_2rem)]"
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="pressable pointer-events-auto ml-auto flex h-7 items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 text-label text-muted-foreground"
        >
          <MonitorIcon className="size-3" />
          Show preview
        </button>
      ) : (
        visible && (
          <PreviewCard
            id={id}
            onClose={() => setCollapsed(true)}
            active={Boolean(activity)}
          />
        )
      )}
    </div>
  )
}

function PreviewCard({
  id,
  onClose,
  active,
}: {
  id: string
  onClose: () => void
  active: boolean
}) {
  const preview = useControlPreview((state) => state.previews[id])
  useEffect(() => watchControlPreview(id), [id])
  const error = useControlPreview((state) => state.errors[id])
  const frame = preview?.frame
  const activity = preview?.activity
  const nativeWindow = preview?.window
  if (!frame && !nativeWindow) return null
  return (
    <section
      aria-label="Live control preview"
      className="overlay-panel pointer-events-auto overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground"
    >
      <div className="group relative flex aspect-video items-center justify-center overflow-hidden bg-background">
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
              alt="Live view of the tab this task is using"
              className="h-full w-full object-contain"
              decoding="async"
            />
          )
        )}
        <button
          type="button"
          aria-label="Hide preview"
          onClick={onClose}
          className="pressable absolute top-2 right-2 flex size-6 items-center justify-center rounded-full border border-hairline bg-popover/90 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex h-8 items-center gap-2 border-t border-hairline px-2.5 text-label">
        {activity?.kind === "browser" ? (
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {activity?.kind === "browser" ? "Browser" : "Computer"}
          {activity ? ` · ${activity.operation.replaceAll("_", " ")}` : ""}
        </span>
        {activity?.status === "running" && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-ember"
            aria-label="Working"
          />
        )}
        {active && (
          <button
            type="button"
            aria-label="Stop task"
            onClick={() => void stopControlTask(id)}
            className="pressable flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-fill-hover hover:text-foreground"
            title="Stop task"
          >
            <SquareIcon className="size-2.5 fill-current" />
          </button>
        )}
      </div>
      {error && (
        <p
          role="status"
          className="px-2.5 pb-2 text-label text-muted-foreground"
        >
          {error}
        </p>
      )}
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
          {poster ? "Latest screenshot" : "Waiting for a screenshot"}
        </span>
      )}
    </>
  )
}
