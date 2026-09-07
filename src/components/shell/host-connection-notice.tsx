import { useHostConnection } from "@/state/host-connection"

export function HostConnectionNotice() {
  const connection = useHostConnection((state) => state)
  if (connection.kind === "connected") return null
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-hairline px-3 py-2 text-ui"
    >
      <p className="min-w-0 flex-1 text-faint">
        {connection.message} Showing the last known state. Your drafts are
        saved.
      </p>
      <button
        type="button"
        className="pressable shrink-0 rounded border border-hairline px-2 py-1 text-foreground hover:bg-fill-hover"
        onClick={() => location.reload()}
      >
        Reconnect
      </button>
    </div>
  )
}
