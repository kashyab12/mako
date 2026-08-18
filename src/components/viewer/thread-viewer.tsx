import { useEffect, useMemo, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Exchange } from "@/components/transcript/exchange"
import { harnessLabel } from "@/components/rail/agent-threads"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { threads, useThreads } from "@/state/threads"
import { acp } from "@/state/acp"
import { toExchanges } from "@/lib/exchanges"
import { threadToMessages } from "@/lib/foreign-thread"
import { formatRelative } from "@/lib/format"
import { ArrowRightIcon, ChevronDownIcon, Loader2Icon, RadioIcon, XIcon } from "lucide-react"

/**
 * A conversation from another harness, opened as a conversation.
 *
 * This takes the transcript's place in the chat column — not a modal, not a
 * popup — and renders through the same prompt cards, markdown prose, and
 * tool rows every native conversation uses, because a conversation is a
 * conversation and only the mark in the corner should say where it
 * happened. The one composer below routes to this session's own harness
 * while it is open; the header holds Live and the Move menu. X or Escape
 * gives the native chat back.
 */

export function ThreadViewer() {
  const thread = useThreads((state) => state.viewing)
  const busy = useThreads((state) => state.viewingBusy)
  const continuing = useThreads((state) => state.continuing)

  useEffect(() => {
    if (!thread) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        threads.closeViewer()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [thread])

  if (busy) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background">
        <Loader2Icon className="size-5 animate-spin text-faint" />
      </div>
    )
  }
  if (!thread) return null
  const { ref } = thread

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hairline px-3.5">
        <span className="flex shrink-0 items-center -space-x-1">
          {(ref.lineage ?? []).map((origin, index) => (
            <HarnessIcon
              key={`${origin.harness}-${index}`}
              harness={origin.harness}
              className="size-3.5 opacity-40"
            />
          ))}
          <HarnessIcon harness={ref.harness} className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium">{ref.title ?? "Untitled session"}</p>
          <p className="truncate text-[10.5px] text-faint">
            {[...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)), harnessLabel(ref.harness)].join(" → ")}
            {ref.model ? ` · ${ref.model}` : ""}
            {ref.updatedAt ? ` · ${formatRelative(ref.updatedAt)}` : ""}
          </p>
        </div>
        <LiveButton />
        <MoveMenu busy={continuing === ref.path} />
        <button
          type="button"
          aria-label="Close"
          onClick={() => threads.closeViewer()}
          className="pressable shrink-0 rounded p-1 text-faint hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <Conversation />
    </div>
  )
}

/**
 * The transcript, in the app's own rendering.
 *
 * Canonical entries convert to native messages and group into exchanges —
 * the same components, the same markdown, the same tool rows as any
 * conversation here. Sticks to the bottom while the live tail appends, and
 * stops sticking the moment the reader scrolls up.
 */
function Conversation() {
  const thread = useThreads((state) => state.viewing)
  const scroller = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  const exchanges = useMemo(
    () => (thread ? toExchanges(threadToMessages(thread.entries)) : []),
    [thread]
  )

  useEffect(() => {
    const node = scroller.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [exchanges.length, thread?.entries.length])

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const node = event.currentTarget
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      {exchanges.length === 0 ? (
        <p className="pt-12 text-center text-[12px] text-faint">
          This session has no readable conversation.
        </p>
      ) : (
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-6 py-6">
          {exchanges.map((exchange) => (
            <Exchange key={exchange.id} exchange={exchange} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Open this session with its own agent, live.
 *
 * The reply bar below is one headless turn; this is the real thing — the
 * agent running as a subprocess, streaming, and asking before it acts. For a
 * Claude Code thread it loads the *same* session, so "go interactive" is not
 * a copy of the conversation, it is the conversation.
 */
function LiveButton() {
  const thread = useThreads((state) => state.viewing)
  const acpable = useThreads((state) => state.acpable)
  if (!thread || acpable.length === 0) return null
  return (
    <button
      type="button"
      onClick={() => {
        const ref = thread.ref
        threads.closeViewer()
        void acp.openInteractive(ref)
      }}
      className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      <RadioIcon className="size-3" />
      Live
    </button>
  )
}


/**
 * Where this conversation can move, said plainly.
 *
 * One menu instead of a split button whose primary read as jargon. Each row
 * names the destination and what moving there means; the conversation
 * becomes a *native* session at the destination, with its history.
 */
function MoveMenu({ busy }: { busy: boolean }) {
  const [open, setOpen] = useState(false)
  const thread = useThreads((state) => state.viewing)
  const targets = useThreads((state) => state.targets)
  if (!thread) return null
  const others = targets.filter((target) => target !== "pi" && target !== thread.ref.harness)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-[11.5px] font-medium text-background transition-opacity hover:opacity-90"
        >
          {busy ? <Loader2Icon className="size-3 animate-spin" /> : <ArrowRightIcon className="size-3" />}
          Move to
          <ChevronDownIcon className="size-2.5 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-72 p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            void threads.continueHere(thread.ref)
          }}
          className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-raised"
        >
          <HarnessIcon harness="pi" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            <span className="block text-[12px] text-foreground/90">Pi — a tab here</span>
            <span className="block text-[10.5px] leading-snug text-faint">
              Becomes a native Pi session with the full history; keep talking in this app.
            </span>
          </span>
        </button>
        {others.map((target) => (
          <button
            key={target}
            type="button"
            onClick={() => {
              setOpen(false)
              void threads.continueWith(thread.ref, target, harnessLabel(target))
            }}
            className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-raised"
          >
            <HarnessIcon harness={target} className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="block text-[12px] text-foreground/90">{harnessLabel(target)}</span>
              <span className="block text-[10.5px] leading-snug text-faint">
                Becomes a native {harnessLabel(target)} session — same conversation, new agent.
              </span>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

