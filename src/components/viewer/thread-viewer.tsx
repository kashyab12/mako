import { useEffect, useMemo, useRef, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { harnessLabel } from "@/components/rail/agent-threads"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { threads, useThreads } from "@/state/threads"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, Loader2Icon, XIcon } from "lucide-react"
import type { EntryBlock, ThreadEntry } from "@/lib/types"

/**
 * A conversation from another harness, readable here.
 *
 * Read-only on purpose: the live agent for this session belongs to Codex or
 * Claude Code or whichever CLI wrote it. What this offers is the transcript
 * — translated to one shape — and one button: continue the conversation in
 * this app, in the same working directory, with the transcript handed over.
 * Cross-harness continuation is a new session that has read the old one, and
 * the interface says exactly that rather than pretending to be the original.
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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-[2px]">
        <Loader2Icon className="size-5 animate-spin text-faint" />
      </div>
    )
  }
  if (!thread) return null
  const { ref } = thread

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Session from ${harnessLabel(ref.harness)}`}
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 pt-[6vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) threads.closeViewer()
      }}
    >
      <div className="glass-panel flex max-h-[86vh] w-full max-w-[52rem] flex-col overflow-hidden rounded-xl">
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
          {/* The conversation's whole life: earlier harnesses dimmed behind
              the one it lives on now. */}
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
            <p className="truncate text-[13px] font-medium">{ref.title ?? "Untitled session"}</p>
            <p className="truncate text-[10.5px] text-faint">
              {[...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)), harnessLabel(ref.harness)].join(" → ")}
              {ref.model ? ` · ${ref.model}` : ""}
              {ref.cwd ? ` · ${ref.cwd}` : ""}
              {ref.updatedAt ? ` · ${formatRelative(ref.updatedAt)}` : ""}
            </p>
          </div>
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

        <Entries entries={thread.entries} />

        <Reply />
      </div>
    </div>
  )
}

/**
 * Every place this conversation can go next.
 *
 * "Continue here" is the primary because this app is where the button lives;
 * the menu holds the rest of the matrix — any harness with a CLI on this
 * machine can pick the conversation up as a fresh session, opened with the
 * handoff. The thread's own harness is not offered: it already has the reply
 * bar below, which continues the *same* session rather than starting one.
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
          Starts a new session in the same folder, opened with this transcript.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The next message, sent through the harness that owns this session.
 *
 * The CLI runs headlessly in the thread's working directory and writes its
 * native store as it works — the same store this viewer is tailing — so the
 * reply streams into the transcript above exactly as if it had been typed in
 * a terminal. This is continuation *with* the original agent; the header's
 * "Continue here" remains the way to bring the conversation to this one.
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
    <div className="shrink-0 border-t border-hairline px-3 py-2.5">
      <div className="flex items-end gap-2">
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
          className="max-h-32 min-h-8 w-full flex-1 resize-none rounded-md bg-surface px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground placeholder:text-faint focus:ring-1 focus:ring-hairline focus:outline-none disabled:opacity-60"
        />
        {running ? (
          <button
            type="button"
            onClick={() => void threads.abortReply(thread.ref)}
            className="pressable flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <Loader2Icon className="size-3 animate-spin" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim()}
            className="pressable flex h-8 shrink-0 items-center rounded-md border border-hairline px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Send
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
  )
}

/**
 * The transcript, sticky at the bottom.
 *
 * When entries stream in from the live tail, someone reading the latest
 * turn should stay on the latest turn — and someone who has scrolled up to
 * read something older should not be yanked away from it. "Near the bottom"
 * is the whole heuristic, measured before the new entries land.
 */
function Entries({ entries }: { entries: ThreadEntry[] }) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  useEffect(() => {
    const node = scroller.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [entries.length])

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const node = event.currentTarget
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
    >
      {entries.length === 0 ? (
        <p className="pt-8 text-center text-[12px] text-faint">
          This session has no readable conversation.
        </p>
      ) : (
        entries.map((entry, index) => <Entry key={index} entry={entry} />)
      )}
    </div>
  )
}

function Entry({ entry }: { entry: ThreadEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="my-3 rounded-lg bg-surface px-3 py-2">
          <p className="pb-0.5 text-[10px] font-medium tracking-wide text-faint uppercase">You</p>
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/95">
            {entry.text}
          </p>
        </div>
      )
    case "event":
      return (
        <p className="my-2 text-center text-[10.5px] text-faint italic">
          {entry.label}
          {entry.detail ? ` — ${entry.detail}` : ""}
        </p>
      )
    case "assistant":
      return (
        <div className="my-3 flex flex-col gap-1.5">
          {entry.blocks.map((block, index) => (
            <Block key={index} block={block} />
          ))}
        </div>
      )
  }
}

function Block({ block }: { block: EntryBlock }) {
  if (block.type === "text") {
    return (
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/90">
        {block.text}
      </p>
    )
  }
  if (block.type === "thinking") return <Folded label="Thinking" text={block.text} dim />
  return <Tool block={block} />
}

/**
 * Tool calls fold shut. A foreign transcript is read to understand what
 * happened, and what happened is legible from the tool names; the payloads
 * are there for the one call that matters.
 */
function Tool({ block }: { block: EntryBlock & { type: "tool" } }) {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => firstUseful(block.input), [block.input])
  return (
    <div className="rounded-md border border-hairline/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 text-faint transition-transform duration-150", open && "rotate-90")}
        />
        <span className={cn("font-mono text-[11px]", block.error ? "text-red-400" : "text-muted-foreground")}>
          {block.name}
        </span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">{summary}</span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-hairline/60 px-2 py-1.5">
          {block.input ? (
            <pre className="max-h-48 overflow-y-auto font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
              {block.input}
            </pre>
          ) : null}
          {block.output ? (
            <pre className="mt-1 max-h-64 overflow-y-auto font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap text-faint">
              {block.output}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Folded({ label, text, dim }: { label: string; text: string; dim?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-[10.5px] text-faint hover:text-muted-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
        {label}
      </button>
      {open ? (
        <p
          className={cn(
            "mt-1 text-[11.5px] leading-relaxed whitespace-pre-wrap",
            dim ? "text-faint italic" : "text-muted-foreground"
          )}
        >
          {text}
        </p>
      ) : null}
    </div>
  )
}

/** The first line of a tool's input that is not JSON punctuation. */
function firstUseful(input: string | undefined): string {
  if (!input) return ""
  const line = input.replace(/^[{["\s]+/, "").split("\n", 1)[0] ?? ""
  return line.slice(0, 90)
}
