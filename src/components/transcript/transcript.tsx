import { useMemo } from "react"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { Launcher } from "@/components/transcript/launcher"
import { MakoMark } from "@/components/ui/mako-mark"
import { Slot } from "@/extend/slot"
import { toExchanges } from "@/lib/exchanges"
import { foldTools } from "@/lib/tools"
import { useSession } from "@/state/session"
import { FolderIcon } from "lucide-react"

export function Transcript() {
  const sessionId = useSession((state) => state.meta?.sessionId)
  return <SessionTranscript key={sessionId ?? "none"} sessionId={sessionId} />
}

function SessionTranscript({ sessionId }: { sessionId: string | undefined }) {
  const messages = useSession((state) => state.messages)
  const stream = useSession((state) => state.stream)
  const exchanges = useMemo(() => {
    const list = toExchanges(foldTools(messages))
    if (!stream) return list
    const last = list.at(-1)
    if (!last) return [{ id: "draft", response: [stream], system: [] }]
    return [
      ...list.slice(0, -1),
      { ...last, response: [...last.response, stream] },
    ]
  }, [messages, stream])

  return (
    <>
      <Slot name="transcript.header" meta={undefined} />
      <ConversationTimeline
        identity={sessionId ?? "none"}
        exchanges={exchanges}
        streamingId={stream ? exchanges.at(-1)?.id : undefined}
        empty={<EmptyTranscript />}
      />
    </>
  )
}

/**
 * The opening screen.
 *
 * The most-seen screen in the app — every new session lands here — so it earns
 * the mark rather than a generic terminal glyph. It carries the two facts
 * worth knowing before typing (which folder the agent can edit, and which
 * model will answer) and three concrete openers. The openers fill the composer
 * rather than sending, so the first message is still the user's.
 */
function EmptyTranscript() {
  const cwd = useSession((state) => state.meta?.cwd)
  const model = useSession((state) => state.meta?.model?.name)

  return (
    <div className="flex min-h-full justify-center px-6">
      <div className="my-auto w-full max-w-[460px] py-8">
        <div className="flex items-center gap-3.5">
          <MakoMark className="size-8 shrink-0 text-foreground/85" />
          <div className="min-w-0">
            <p className="text-title leading-tight font-semibold tracking-[-0.01em]">
              Ask for anything
            </p>
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-ui text-faint">
              <FolderIcon className="size-3 shrink-0" />
              <span className="truncate" title={cwd}>
                {cwd ?? "no workspace"}
              </span>
              {model ? (
                <>
                  <span className="text-faint/50">·</span>
                  <span className="shrink-0 truncate">{model}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <Slot name="transcript.empty" meta={undefined} />
        <Launcher />
      </div>
    </div>
  )
}
