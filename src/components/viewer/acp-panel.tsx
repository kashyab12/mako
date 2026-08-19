import { useEffect, useRef, useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/agent-threads"
import { acp, acpStore, useAcp, type AcpBlock } from "@/state/acp"
import { cn } from "@/lib/utils"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  Loader2Icon,
  ShieldQuestionIcon,
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
 * would resume, not a copy. The one composer below the column does the
 * talking; this surface is the transcript, the permission question, and the
 * agent's own modes.
 */

export function AcpPanel() {
  const session = useAcp((state) => state.session)
  const starting = useAcp((state) => state.starting)

  useEffect(() => {
    if (!session) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        // The same muscle memory as the native transcript: Escape during a
        // turn stops the turn. Only an idle Escape closes the session —
        // ending a live agent because the user tried to interrupt it was
        // this panel's worst surprise.
        if (acpStore.get().session?.status === "running") acp.cancel()
        else acp.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [session])

  if (starting) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-[12px] text-faint">
          <Loader2Icon className="size-4 animate-spin" />
          Starting the agent…
        </div>
      </div>
    )
  }
  if (!session) return null

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hairline px-3.5">
        <HarnessIcon harness={session.harness} className="size-3.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium">
            {session.title ?? `${harnessLabel(session.harness)}, live`}
          </p>
          <p className="truncate text-[10.5px] text-faint">
            {harnessLabel(session.harness)} · live · {session.cwd}
          </p>
        </div>
        <ModePicker />
        <button
          type="button"
          aria-label="End live session"
          title="Ends the live session — the conversation stays in Threads"
          onClick={() => acp.close()}
          className="pressable shrink-0 rounded p-1 text-faint hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <Blocks />
      <Permission />
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
          <p className="pb-0.5 text-[10.5px] font-medium text-faint">You</p>
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
          <p className="pb-1 text-[10.5px] font-medium text-faint">Plan</p>
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
      {open && (block.input || block.output) ? (
        <div className="max-h-72 overflow-y-auto border-t border-hairline/60">
          {block.input ? (
            <pre className="px-2 py-1.5 font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap text-faint">
              {block.input}
            </pre>
          ) : null}
          {block.output ? (
            <pre className="border-t border-hairline/60 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed break-words whitespace-pre-wrap text-faint">
              {block.output}
            </pre>
          ) : null}
        </div>
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

