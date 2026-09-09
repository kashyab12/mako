import { useState } from "react"
import { XIcon } from "lucide-react"
import type { RejectedDraft } from "@/state/drafts"
import { takeInterruptedSend, useSendRecovery } from "@/state/send-recovery"

export function InterruptedSends({
  onRestore,
}: {
  onRestore: (draft: RejectedDraft) => void
}) {
  const drafts = useSendRecovery((state) => state.interrupted)
  const [expanded, setExpanded] = useState(false)
  if (!drafts.length) return null
  return (
    <section
      aria-label="Interrupted sends"
      className="mx-2 mb-2 rounded-md border border-hairline p-2"
    >
      <p className="text-ui text-foreground">Send interrupted</p>
      <p className="mt-1 text-label text-faint">
        Delivery could not be confirmed. Check the conversation before sending
        again.
      </p>
      <div className="max-h-40 overflow-auto">
        {drafts.slice(0, expanded ? 20 : 2).map((draft) => (
          <div key={draft.id} className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className="pressable min-w-0 flex-1 rounded px-1 py-1 text-left text-ui text-muted-foreground hover:bg-fill-hover"
              onClick={() => {
                onRestore(draft)
                takeInterruptedSend(draft.id)
              }}
            >
              <span className="block truncate">
                {draft.text || "Attachments"}
              </span>
              <span className="text-label text-faint">
                Restore to current draft
              </span>
            </button>
            <button
              type="button"
              aria-label="Dismiss recovery copy"
              title="Dismiss recovery copy"
              className="pressable grid size-6 shrink-0 place-items-center rounded text-faint hover:bg-fill-hover"
              onClick={() => takeInterruptedSend(draft.id)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      {drafts.length > 2 && !expanded ? (
        <button
          type="button"
          className="pressable mt-2 text-label text-faint"
          onClick={() => setExpanded(true)}
        >
          Show more recovery copies
        </button>
      ) : null}
      {expanded && drafts.length > 20 ? (
        <p className="mt-2 text-label text-faint">
          Restore or dismiss a copy to see the next one.
        </p>
      ) : null}
    </section>
  )
}
