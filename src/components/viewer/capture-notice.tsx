import { threads, threadsStore } from "@/state/threads"
import { activeAcp, useAcp } from "@/state/acp"

export function CaptureNotice() {
  const path = useAcp((state) => activeAcp(state)?.threadPath)
  return (
    <div className="border-b border-hairline px-3.5 py-2 text-ui text-muted-foreground">
      This conversation is saved. Sending a message starts a provider connection
      from this captured history.
      {path ? (
        <button
          className="pressable ml-2 underline"
          onClick={() => {
            const ref = threadsStore
              .get()
              .threads.find((item) => item.path === path)
            if (ref) void threads.view(ref, "native")
          }}
        >
          View current provider history
        </button>
      ) : null}
    </div>
  )
}
