import { useEffect, useRef, useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/agent-threads"
import { acp, useAcp, type AcpBlock } from "@/state/acp"
import { cn } from "@/lib/utils"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  Loader2Icon,
  ShieldQuestionIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"

/**
 * A foreign agent, live.
 *
 * This is the difference between reading another harness's session and
 * *driving* it: tokens stream as they are generated, tool calls appear as
 * they run, and when the agent wants a permission its mode does not grant,
 * the question lands here — with the agent's own options, not a yes/no we
 * invented. A Claude Code thread opened this way is the same session its CLI
 * would resume, not a copy.
 */

export function AcpPanel() {
  const session = useAcp((state) => state.session)
  const starting = useAcp((state) => state.starting)

  useEffect(() => {
    if (!session) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        acp.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [session])

  if (starting) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/60 backdrop-blur-[2px]">
        <div className="flex items-center gap-2 text-[12px] text-faint">
          <Loader2Icon className="size-4 animate-spin" />
          Starting the agent…
        </div>
      </div>
    )
  }
  if (!session) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Interactive ${harnessLabel(session.harness)} session`}
      className="fixed inset-0 z-[60] flex items-start justify-center bg-background/70 pt-[5vh] backdrop-blur-[2px]"
    >
      <div className="glass-panel flex max-h-[88vh] w-full max-w-[54rem] flex-col overflow-hidden rounded-xl">
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-hairline px-4">
          <HarnessIcon harness={session.harness} className="size-3.5" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">
              {session.title ?? `${harnessLabel(session.harness)}, live`}
            </p>
            <p className="truncate text-[10.5px] text-faint">
              {harnessLabel(session.harness)} · interactive · {session.cwd}
            </p>
          </div>
          <ModePicker />
          <button
            type="button"
            aria-label="Close"
            onClick={() => acp.close()}
            className="pressable shrink-0 rounded p-1 text-faint hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        <Blocks />
        <Permission />
        <Composer />
      </div>
    </div>
  )
}

/**
 * The agent's own modes, verbatim. "acceptEdits" and "plan" are its words
 * for its behaviours; renaming them here would mean documenting a mapping
 * forever.
 */
function ModePicker() {
  const session = useAcp((state) => state.session)
  if (!session || session.modes.length === 0) return null
  return (
    <select
      value={session.currentMode ?? ""}
      onChange={(event) => acp.setMode(event.target.value)}
      className="h-6 shrink-0 rounded border border-hairline bg-surface px-1 text-[10.5px] text-muted-foreground focus:outline-none"
    >
      {session.modes.map((mode) => (
        <option key={mode.id} value={mode.id}>
          {mode.name}
        </option>
      ))}
    </select>
  )
}

function Blocks() {
  const blocks = useAcp((state) => state.blocks)
  const running = useAcp((state) => state.session?.status === "running")
  const scroller = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  useEffect(() => {
    const node = scroller.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [blocks])

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const node = event.currentTarget
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
    >
      {blocks.length === 0 ? (
        <p className="pt-8 text-center text-[12px] leading-relaxed text-faint">
          The session is loaded. Anything you send continues it — same
          conversation, same working directory.
        </p>
      ) : (
        blocks.map((block, index) => <Block key={index} block={block} />)
      )}
      {running ? (
        <div className="flex items-center gap-1.5 py-2 text-[11px] text-faint">
          <Loader2Icon className="size-3 animate-spin" />
          working
        </div>
      ) : null}
    </div>
  )
}

function Block({ block }: { block: AcpBlock }) {
  switch (block.type) {
    case "user":
      return (
        <div className="my-3 rounded-lg bg-surface px-3 py-2">
          <p className="pb-0.5 text-[10px] font-medium tracking-wide text-faint uppercase">You</p>
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/95">{block.text}</p>
        </div>
      )
    case "text":
      return (
        <p className="my-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/90">{block.text}</p>
      )
    case "thinking":
      return <Thinking text={block.text} />
    case "tool":
      return <Tool block={block} />
    case "plan":
      return (
        <div className="my-2 rounded-md border border-hairline/60 px-2.5 py-1.5">
          <p className="pb-1 text-[10px] font-medium tracking-wide text-faint uppercase">Plan</p>
          {block.entries.map((entry, index) => (
            <p key={index} className="flex items-center gap-1.5 py-px text-[11.5px] text-muted-foreground">
              {entry.status === "completed" ? (
                <CheckIcon className="size-3 text-emerald-400/80" />
              ) : entry.status === "in_progress" ? (
                <Loader2Icon className="size-3 animate-spin text-faint" />
              ) : (
                <CircleIcon className="size-2.5 text-faint/60" />
              )}
              <span className={cn(entry.status === "completed" && "text-faint line-through")}>{entry.content}</span>
            </p>
          ))}
        </div>
      )
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-[10.5px] text-faint hover:text-muted-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
        Thinking
      </button>
      {open ? (
        <p className="mt-1 text-[11.5px] leading-relaxed whitespace-pre-wrap text-faint italic">{text}</p>
      ) : null}
    </div>
  )
}

function Tool({ block }: { block: AcpBlock & { type: "tool" } }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 rounded-md border border-hairline/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
      >
        {block.status === "completed" ? (
          <CheckIcon className="size-3 shrink-0 text-emerald-400/70" />
        ) : block.status === "failed" ? (
          <XIcon className="size-3 shrink-0 text-red-400/80" />
        ) : (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-faint" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{block.title}</span>
      </button>
      {open && block.output ? (
        <pre className="max-h-56 overflow-y-auto border-t border-hairline/60 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap text-faint">
          {block.output}
        </pre>
      ) : null}
    </div>
  )
}

/**
 * The agent's question, with the agent's answers.
 *
 * The options come from the agent — allow once, allow always, reject — and
 * they render in its order, verbatim. This is the moment the whole panel
 * exists for; it should read as a question, not an alert.
 */
function Permission() {
  const permission = useAcp((state) => state.permission)
  if (!permission) return null
  return (
    <div className="shrink-0 border-t border-hairline bg-surface/60 px-4 py-2.5">
      <p className="flex items-center gap-1.5 pb-1.5 text-[11.5px] text-foreground/90">
        <ShieldQuestionIcon className="size-3.5 shrink-0 text-amber-300/90" />
        <span className="min-w-0 truncate font-mono">{permission.title}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            onClick={() => acp.answerPermission(option.optionId)}
            className={cn(
              "pressable rounded-md border px-2 py-1 text-[11px] transition-colors",
              option.kind?.startsWith("allow")
                ? "border-hairline bg-foreground text-background hover:opacity-90"
                : "border-hairline text-muted-foreground hover:text-foreground"
            )}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function Composer() {
  const session = useAcp((state) => state.session)
  const [draft, setDraft] = useState("")
  if (!session) return null
  const running = session.status === "running"

  const send = () => {
    const text = draft.trim()
    if (!text || running) return
    setDraft("")
    void acp.send(text)
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
          placeholder={running ? "Working — Enter to queue is not a thing yet; Stop first" : "Message the agent"}
          disabled={running}
          className="max-h-32 min-h-8 w-full flex-1 resize-none rounded-md bg-surface px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground placeholder:text-faint focus:ring-1 focus:ring-hairline focus:outline-none disabled:opacity-60"
        />
        {running ? (
          <button
            type="button"
            onClick={() => acp.cancel()}
            className="pressable flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <SquareIcon className="size-3" />
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
    </div>
  )
}
