import { useEffect } from "react"
import { MonitorIcon, GlobeIcon } from "lucide-react"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { useControlPreview, watchControlPreview } from "@/state/control-preview"

export function ControlPreviewPanel() {
  const conversationId = useAcp(
    (state) => activeLiveAcp(state)?.session.id ?? null
  )
  const preview = useControlPreview((state) =>
    conversationId ? state.previews[conversationId] : null
  )
  const error = useControlPreview((state) =>
    conversationId ? state.errors[conversationId] : null
  )
  useEffect(
    () => (conversationId ? watchControlPreview(conversationId) : undefined),
    [conversationId]
  )
  const activity = preview?.activity
  const frame = preview?.frame
  return (
    <section
      className="flex h-full flex-col overflow-y-auto p-4"
      aria-label="Control preview"
    >
      <div className="mb-4 flex items-center gap-2 text-ui font-medium">
        {activity?.kind === "browser" ? (
          <GlobeIcon className="size-4" />
        ) : (
          <MonitorIcon className="size-4" />
        )}
        <span>{activity?.kind === "browser" ? "Browser" : "Computer"}</span>
        {activity && (
          <span className="ml-auto text-label font-normal text-muted-foreground">
            {activity.status === "running"
              ? "Working"
              : activity.status === "error"
                ? "Action failed"
                : "Last observed"}
          </span>
        )}
      </div>
      {frame ? (
        <figure className="m-0 overflow-hidden rounded-lg border border-border bg-background">
          <img
            className="block h-auto w-full object-contain"
            src={`data:${frame.image.mimeType};base64,${frame.image.data}`}
            alt={`${activity?.kind === "browser" ? "Browser tab" : "Application window"} observed by this task`}
            decoding="async"
          />
          <figcaption className="border-t border-border px-3 py-2 text-label text-muted-foreground">
            Captured {new Date(frame.capturedAt).toLocaleTimeString()}
          </figcaption>
        </figure>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-border p-6 text-center text-ui text-muted-foreground">
          <MonitorIcon className="size-7" />
          <p>
            {conversationId
              ? "The next browser or computer observation appears here."
              : "Open a task to see its browser and computer activity."}
          </p>
        </div>
      )}
      {activity && (
        <div className="mt-4 space-y-1 text-ui">
          <p className="font-medium">
            {activity.operation.replaceAll("_", " ")}
          </p>
          <p className="text-label break-all text-muted-foreground">
            {activity.kind === "browser"
              ? "This task’s selected browser tab"
              : "This task’s selected application window"}
          </p>
        </div>
      )}
      <p className="mt-4 text-label text-muted-foreground">
        Browser previews update while this panel is visible. Computer previews
        show the task’s latest screenshot.
      </p>
      {error && (
        <p role="status" className="mt-3 text-ui text-muted-foreground">
          {error}
        </p>
      )}
    </section>
  )
}
