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
import { cn } from "@/lib/utils"
import { ArrowRightIcon, ChevronDownIcon, Loader2Icon, RadioIcon, XIcon } from "lucide-react"

/**
 * A conversation from another harness, opened as a conversation.
 *
 * This takes the transcript's place in the chat column — not a modal, not a
 * popup — and renders through the same prompt cards, markdown prose, and
 * tool rows every native conversation uses, because a conversation is a
 * conversation and only the mark in the corner should say where it
 * happened. The reply bar at the bottom continues the *same* session
 * through its own harness; the header holds the ways it can move. X or
 * Escape gives the chat back.
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
      <div className="absolute inset-0 z-30 flex items-center justify-center bg-background">
        <Loader2Icon className="size-5 animate-spin text-faint" />
      </div>
    )
  }
  if (!thread) return null
  const { ref } = thread

  return (
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background">
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
        <div className="flex shrink-0 items-center overflow-hidden rounded-md bg-foreground">
          <button
            type="button"
            disabled={continuing === ref.path}
            onClick={() => void threads.continueHere(ref)}
            className={cn(
              "pressable flex h-7 items-center gap-1.5 px-2.5 text-[11.5px] font-medium text-background",
              "transition-opacity hover:opacity-90 disabled:opacity-50"
            )}
          >
            {continuing === ref.path ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <ArrowRightIcon className="size-3" />
            )}
            Continue here
          </button>
          <ContinueMenu />
        </div>
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
      <Reply />
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
 * Every place this conversation can go next.
 *
 * "Continue here" is the primary because this app is where the button lives;
 * the menu holds the rest of the matrix — any harness whose store we can
 * write receives the conversation as a native session. The thread's own
 * harness is not offered: the reply bar below continues the *same* session.
 */
function ContinueMenu() {
  const [open, setOpen] = useState(false)
  const thread = useThreads((state) => state.viewing)
  const targets = useThreads((state) => state.targets)
  if (!thread) return null
  const others = targets.filter((target) => target !== "pi" && target !== thread.ref.harness)
  if (others.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Continue with another agent"
          className="pressable flex h-7 items-center border-l border-background/20 px-1.5 text-background transition-opacity hover:opacity-90"
        >
          <ChevronDownIcon className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-56 p-1">
        <p className="px-2 pt-1 pb-1.5 text-[10.5px] text-faint">Hand the conversation to</p>
        {others.map((target) => (
          <button
            key={target}
            type="button"
            onClick={() => {
              setOpen(false)
              void threads.continueWith(thread.ref, target, harnessLabel(target))
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/90 transition-colors hover:bg-raised"
          >
            <HarnessIcon harness={target} className="size-3.5" />
            {harnessLabel(target)}
          </button>
        ))}
        <p className="px-2 pt-1.5 pb-1 text-[10px] leading-snug text-faint">
          Becomes a native session there — same conversation, new harness.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The next message, sent through the harness that owns this session.
 *
 * The CLI runs headlessly in the thread's working directory and writes its
 * native store as it works — the same store this view is tailing — so the
 * reply streams into the transcript above exactly as if it had been typed in
 * a terminal.
 */
function Reply() {
  const thread = useThreads((state) => state.viewing)
  const resumable = useThreads((state) => state.resumable)
  const run = useThreads((state) => state.run)
  const [draft, setDraft] = useState("")

  if (!thread || !resumable.includes(thread.ref.harness)) return null
  const running = run?.status === "running"
  const label = harnessLabel(thread.ref.harness)

  const send = () => {
    const text = draft.trim()
    if (!text || running) return
    setDraft("")
    void threads.reply(thread.ref, text)
  }

  return (
    <div className="shrink-0 border-t border-hairline px-4 py-3">
      <div className="mx-auto w-full max-w-[760px]">
        <div className="flex items-end gap-2 rounded-xl bg-raised px-1.5 py-1.5 ring-1 ring-hairline ring-inset">
          <HarnessIcon harness={thread.ref.harness} className="mb-2 ml-1.5 size-3.5 shrink-0" />
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder={running ? `${label} is working…` : `Reply with ${label}`}
            disabled={running}
            className="max-h-40 min-h-9 w-full flex-1 resize-none bg-transparent px-1 py-1.5 text-[13px] leading-relaxed text-foreground placeholder:text-faint focus:outline-none disabled:opacity-60"
          />
          {running ? (
            <button
              type="button"
              onClick={() => void threads.abortReply(thread.ref)}
              className="pressable mb-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-hairline px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground"
            >
              <Loader2Icon className="size-3 animate-spin" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!draft.trim()}
              className="pressable mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-40"
              aria-label="Send"
            >
              <ArrowRightIcon className="size-3.5 -rotate-90" />
            </button>
          )}
        </div>
        {run?.status === "failed" && run.error ? (
          <p className="pt-1.5 text-[10.5px] text-red-400">{run.error}</p>
        ) : null}
        <p className="pt-1.5 text-[10px] text-faint">
          {thread.ref.harness === "devin"
            ? "Sends to the running Devin session in the cloud."
            : `Runs ${label} headlessly in ${thread.ref.cwd ?? "its workspace"} with tool approvals on.`}
        </p>
      </div>
    </div>
  )
}
