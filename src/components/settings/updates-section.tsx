import { Action } from "@/components/ui/kit"
import { updates, useUpdates } from "@/state/updates"

/** Which version is running, and whether there is a newer one. */
export function UpdatesSection() {
  const status = useUpdates((state) => state.status)
  const version = useUpdates((state) => state.version)
  const available = useUpdates((state) => state.available)
  const progress = useUpdates((state) => state.progress)
  const notes = useUpdates((state) => state.notes)
  const error = useUpdates((state) => state.error)

  return (
    <div className="rounded-lg bg-surface px-3 py-3 ring-1 ring-hairline">
      <div className="flex items-baseline gap-2">
        <span className="text-ui font-medium">
          Mako {version || "—"}
        </span>
        <span className="text-ui text-faint">
          {status === "unsupported"
            ? "running from a checkout, so there is nothing to update"
            : status === "checking"
              ? "checking…"
              : status === "downloading"
                ? `downloading ${available ?? ""} · ${progress ?? 0}%`
                : status === "ready"
                  ? `${available} is ready to install`
                  : status === "error"
                    ? (error ?? "could not reach the update feed")
                    : "up to date"}
        </span>
      </div>

      {notes ? (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-raised p-2 text-label leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {notes}
        </pre>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        {status === "ready" ? (
          <Action tone="solid" onClick={() => updates.install()}>
            Restart and install
          </Action>
        ) : null}
        <Action
          tone="outline"
          disabled={status === "checking" || status === "unsupported"}
          onClick={() => void updates.check()}
        >
          Check now
        </Action>
      </div>

      <p className="mt-3 text-ui leading-relaxed text-faint">
        Updates download on their own but never install on their own. A turn
        can run for minutes and touch real files; restarting underneath one is
        not an improvement.
      </p>
    </div>
  )
}
