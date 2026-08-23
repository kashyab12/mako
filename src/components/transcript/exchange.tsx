import { memo, useMemo, useState } from "react"
import { Prose } from "@/components/transcript/markdown"
import { ToolRow } from "@/components/transcript/tool-row"
import { FileChip, SkillChip, ThreadChip } from "@/components/composer/reference-chip"
import { Slot } from "@/extend/slot"
import { tokenize } from "@/lib/mentions"
import {
  isSubagentLaunch,
  pairTools,
  reportedSubagentCount,
} from "@/lib/tools"
import { formatTime, textOf } from "@/lib/format"
import { parseAttachmentAppendix } from "@/lib/attachments"
import { stripThreadReferenceAppendix } from "@/lib/thread-references"
import {
  responseSections,
  responseText,
  type Exchange as ExchangeData,
} from "@/lib/exchanges"
import { actions, shallowEqual, useSession } from "@/state/session"
import { threads, useThreads } from "@/state/threads"
import { HARNESS_LABEL } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@/lib/types"
import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  GitForkIcon,
  PencilIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react"

/**
 * One question and the answer to it.
 *
 * Grouping by exchange is what lets the prompt be unmistakably the user's —
 * it gets its own surface rather than a hairline that reads like a quote — and
 * what lets "copy" mean "the agent's answer to this", once, instead of
 * appearing on every fragment of a long reply.
 */
export const Exchange = memo(function Exchange({
  exchange,
  streaming,
  interrupted,
  failed,
}: {
  exchange: ExchangeData
  streaming?: boolean
  interrupted?: boolean
  failed?: boolean
}) {
  const sections = useMemo(
    () => responseSections(exchange.response),
    [exchange.response]
  )
  const provider = exchange.response.find(
    (message) => message.provider && HARNESS_LABEL[message.provider]
  )?.provider
  return (
    <article data-exchange={exchange.id} className="contain-turn scroll-mt-6">
      {exchange.prompt ? <Prompt message={exchange.prompt} /> : null}

      {exchange.system.map((message) => (
        <SystemNote key={message.id} message={message} />
      ))}

      {sections.length > 0 ? (
        <div className={cn("flex flex-col gap-2.5", exchange.prompt && "mt-3")}>
          {provider ? <AgentByline provider={provider} /> : null}
          {sections.map((section, index) =>
            section.kind === "prose" ? (
              <Response key={section.id} message={section.message} showWork />
            ) : (
              <WorkSection
                key={section.id}
                messages={section.messages}
                startedAt={index === 0 ? exchange.prompt?.timestamp : undefined}
                live={Boolean(streaming && index === sections.length - 1)}
                interrupted={Boolean(
                  interrupted && index === sections.length - 1
                )}
                failed={Boolean(failed && index === sections.length - 1)}
              />
            )
          )}
        </div>
      ) : null}

      {!streaming && exchange.response.length > 0 ? <Footer exchange={exchange} /> : null}
    </article>
  )
})

function AgentByline({ provider }: { provider: string }) {
  return (
    <div className="flex items-center gap-1.5 text-label text-faint">
      <HarnessIcon harness={provider} className="size-3.5" />
      <span>{HARNESS_LABEL[provider] ?? provider}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* the prompt                                                          */
/* ------------------------------------------------------------------ */

function Prompt({ message }: { message: ChatMessage }) {
  const raw = textOf(message.blocks)
  // Sent context appendices read back as chips, not walls of implementation detail.
  const { body: text, files } = useMemo(
    () => parseAttachmentAppendix(stripThreadReferenceAppendix(raw)),
    [raw]
  )
  // References the user typed read back as the chips they were written as.
  const segments = useMemo(() => tokenize(text), [text])
  // Edit and Fork exist only where the session tree knows this message —
  // native conversations. A foreign transcript's synthetic ids stay quiet.
  const node = useSession((state) => {
    const found = state.tree.find((entry) => entry.id === message.id)
    return found ? { id: found.id, parentId: found.parentId } : null
  }, shallowEqual)

  const editHere = async () => {
    // Rewind the conversation to just before this prompt, then hand the
    // words back for editing. Nothing is lost: the turns that followed
    // stay reachable as a branch in History.
    if (!node) return
    if (node.parentId) await actions.navigate(node.parentId)
    window.dispatchEvent(new CustomEvent("mako:compose", { detail: text }))
  }

  return (
    <div className="group/prompt relative flex flex-col items-end">
      {/* The user's words are a bubble, not a slab: right-aligned and capped
          at a reading measure, unmistakably theirs without a ring. The
          assistant's reply below stays full-width and chrome-free. */}
      <div className="max-w-[min(82%,64ch)] rounded-xl rounded-br-md bg-raised px-3.5 py-2.5">
        <div className="text-prose whitespace-pre-wrap text-foreground">
          {segments.map((segment, index) =>
            segment.kind === "text" ? (
              <span key={index}>{segment.text}</span>
            ) : segment.kind === "file" ? (
              <FileChip key={index} path={segment.path} interactive />
            ) : segment.kind === "thread" ? (
              <ThreadChip key={index} harness={segment.harness} nativeId={segment.nativeId} />
            ) : (
              <SkillChip key={index} name={segment.name} />
            )
          )}
        </div>
        {files.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {files.map((file) => (
              <FileChip key={file.path} path={file.path} interactive />
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-1 flex h-4 items-center justify-end gap-2 px-0.5 text-label text-faint opacity-0 transition-opacity duration-150 group-hover/prompt:opacity-100 focus-within:opacity-100">
        {message.timestamp ? <span className="tabular">{formatTime(message.timestamp)}</span> : null}
        <button
          type="button"
          title="Put this prompt back in the composer"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("mako:compose", { detail: text }))
          }
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          <RotateCcwIcon className="size-3" />
          Reuse
        </button>
        {node ? (
          <>
            <button
              type="button"
              title="Rewind to here and re-ask — later turns stay reachable in History"
              onClick={() => void editHere()}
              className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <PencilIcon className="size-3" />
              Edit
            </button>
            <button
              type="button"
              title="Branch from this point into a new tab — both lines stay open"
              onClick={() => void actions.fork(message.id)}
              className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
            >
              <GitForkIcon className="size-3" />
              Fork
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* the response                                                        */
/* ------------------------------------------------------------------ */

interface WorkSummaryData {
  tools: number
  agents: number
  failed: number
  duration?: number
}

function summarizeWork(
  messages: ChatMessage[],
  started?: number
): WorkSummaryData {
  let tools = 0
  let agents = 0
  let failed = 0
  for (const message of messages) {
    const calls = pairTools(message.blocks)
    tools += calls.length
    agents += calls.filter(isSubagentLaunch).length
    agents = Math.max(agents, ...calls.map(reportedSubagentCount))
    failed += calls.filter((call) => call.isError).length
  }
  const completed = messages.at(-1)?.timestamp
  return {
    tools,
    agents,
    failed,
    duration:
      started !== undefined && completed !== undefined && completed >= started
        ? completed - started
        : undefined,
  }
}

function WorkSection({
  messages,
  startedAt,
  live,
  interrupted,
  failed,
}: {
  messages: ChatMessage[]
  startedAt?: number
  live: boolean
  interrupted: boolean
  failed: boolean
}) {
  const [open, setOpen] = useState(false)
  const work = useMemo(
    () => summarizeWork(messages, startedAt),
    [messages, startedAt]
  )
  const folded = work.tools >= 3
  const showWork = live || open
  return (
    <div className="flex flex-col gap-2.5">
      {folded ? (
        <WorkSummary
          work={work}
          live={live}
          interrupted={interrupted}
          failed={failed}
          open={showWork}
          onToggle={() => {
            if (!live) setOpen((value) => !value)
          }}
        />
      ) : null}
      {!folded || showWork
        ? messages.map((message) => (
            <Response key={message.id} message={message} showWork />
          ))
        : null}
    </div>
  )
}

function WorkSummary({
  work,
  live,
  interrupted,
  failed,
  open,
  onToggle,
}: {
  work: WorkSummaryData
  live: boolean
  interrupted: boolean
  failed: boolean
  open: boolean
  onToggle: () => void
}) {
  const elapsed = work.duration !== undefined ? formatDuration(work.duration) : undefined
  const pieces = [
    live
      ? "Working"
      : interrupted
        ? elapsed
          ? `Interrupted after ${elapsed}`
          : "Interrupted"
        : failed
          ? elapsed
            ? `Failed after ${elapsed}`
            : "Failed"
          : elapsed
            ? `Worked for ${elapsed}`
            : "Work log",
    work.agents > 0
      ? `${work.agents} background agent${work.agents === 1 ? "" : "s"}`
      : null,
    `${work.tools} tools`,
    work.failed > 0 ? `${work.failed} failed` : null,
  ].filter(Boolean)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "pressable flex h-7 w-fit items-center gap-1.5 rounded-md bg-raised px-2 text-label transition-colors duration-100 hover:text-muted-foreground",
        interrupted
          ? "text-caution"
          : failed
            ? "text-negative"
            : live
              ? "text-muted-foreground"
              : "text-faint"
      )}
    >
      {live ? (
        <span className="size-1.5 animate-live rounded-full bg-ember" />
      ) : interrupted || failed ? (
        <TriangleAlertIcon className="size-3" />
      ) : null}
      <ChevronRightIcon
        className={cn(
          "size-3 [transition:transform_150ms_var(--ease-out)]",
          open && "rotate-90"
        )}
      />
      {pieces.join(" · ")}
    </button>
  )
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes < 60) return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function Response({
  message,
  showWork,
}: {
  message: ChatMessage
  showWork: boolean
}) {
  const showThinking = usePrefs((prefs) => prefs.showThinking)

  const { thinking, tools, text } = useMemo(() => {
    const thinkingParts: string[] = []
    const textParts: string[] = []
    for (const block of message.blocks) {
      if (block.type === "thinking" && block.thinking) thinkingParts.push(block.thinking)
      if (block.type === "text" && block.text) textParts.push(block.text)
    }
    return {
      thinking: thinkingParts.join("\n\n"),
      tools: pairTools(message.blocks),
      text: textParts.join(""),
    }
  }, [message.blocks])

  const blank = !thinking && !tools.length && !text && !message.error
  const visible =
    text ||
    message.error ||
    (showWork && tools.length > 0) ||
    (showWork && showThinking && thinking) ||
    (blank && message.streaming)
  if (!visible) return null

  return (
    <div className="flex flex-col gap-2.5">
      {showWork && thinking && showThinking ? (
        <Thinking text={thinking} live={Boolean(message.streaming && !text)} />
      ) : null}

      {showWork && tools.length > 0 ? (
        <div className="flex flex-col gap-1">
          {tools.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      ) : null}

      {text ? <Prose text={text} streaming={message.streaming} /> : null}

      {message.error ? (
        <div className="flex items-start gap-2 rounded-md border border-negative/30 bg-negative/[0.06] px-2.5 py-2 text-ui text-negative">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{message.error}</span>
        </div>
      ) : null}

      {blank && message.streaming ? <p className="shimmer text-ui">Thinking…</p> : null}
    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md bg-foreground/[0.045]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-ui text-faint transition-colors duration-100 hover:text-muted-foreground"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 [transition:transform_150ms_var(--ease-out)]",
            open && "rotate-90"
          )}
        />
        <BrainIcon className="size-3" />
        <span className={cn(live && "shimmer")}>{live ? "Reasoning…" : "Reasoning"}</span>
      </button>
      {open ? (
        <p className="border-t border-hairline px-2.5 py-2 text-ui leading-[1.65] whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      ) : null}
    </div>
  )
}

function SystemNote({ message }: { message: ChatMessage }) {
  const text = textOf(message.blocks)
  if (!text) return null
  return (
    <div className="my-3 flex items-center gap-2.5">
      <span className="h-px flex-1 bg-hairline" />
      <span className="shrink-0 text-label text-faint">{text.slice(0, 140)}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* one footer per answer                                               */
/* ------------------------------------------------------------------ */

function Footer({ exchange }: { exchange: ExchangeData }) {
  const [copied, setCopied] = useState(false)
  const text = responseText(exchange)
  const last = exchange.response.at(-1)
  if (!text && !last?.timestamp) return null

  return (
    <div className="mt-1.5 flex h-4 items-center gap-2.5 text-label text-faint opacity-0 transition-opacity duration-150 group-hover/transcript:opacity-100 focus-within:opacity-100">
      {last?.timestamp ? <span className="tabular">{formatTime(last.timestamp)}</span> : null}
      {last?.model ? <span className="truncate">{last.model}</span> : null}
      {text ? (
        <button
          type="button"
          title="Copy the agent's whole answer to this question"
          onClick={() => {
            actions.copy(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }}
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          {copied ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3" />}
          {copied ? "Copied answer" : "Copy answer"}
        </button>
      ) : null}
      <ForkButton exchange={exchange} />
      {last ? <Slot name="transcript.turn.trailing" message={last} /> : null}
    </div>
  )
}

/**
 * Fork from this answer. The conversation up to and including this turn
 * becomes a NEW thread — on the same harness or any other — while the
 * original stays open. Foreign turns fork through the emitters (their
 * message ids carry the entry index); native turns already have Fork on
 * the prompt, so this stays quiet there.
 */
function ForkButton({ exchange }: { exchange: ExchangeData }) {
  const [open, setOpen] = useState(false)
  const viewing = useThreads((state) => state.viewing?.ref)
  const targets = useThreads((state) => state.targets)
  const last = exchange.response.at(-1)
  const nativeEntry = useSession((state) =>
    last && state.tree.some((entry) => entry.id === last.id) ? last.id : null
  )
  const at = last ? /^foreign-entry-(\d+)$/.exec(last.id) : null
  const entryIndex = at ? Number(at[1]) : null
  if (!viewing && nativeEntry) {
    return (
      <button
        type="button"
        title="Fork from this completed answer into a new tab"
        onClick={() => void actions.fork(nativeEntry, "at")}
        className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
      >
        <GitForkIcon className="size-3" />
        Fork
      </button>
    )
  }
  if (!viewing || entryIndex === null || Number.isNaN(entryIndex)) return null
  const options = targets

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Fork from this answer into a new thread — any harness"
          className="pressable flex items-center gap-1 rounded px-1 hover:text-foreground"
        >
          <GitForkIcon className="size-3" />
          Fork
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={6} className="w-56 p-1">
        <p className="px-2 pt-1.5 pb-1 text-label font-medium text-faint/80">
          Fork from here into
        </p>
        {options.map((target) => (
          <button
            key={target}
            type="button"
            onClick={() => {
              setOpen(false)
              void threads.forkAt(viewing, entryIndex, target)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-foreground/90 transition-colors duration-100 hover:bg-fill-hover"
          >
            <HarnessIcon harness={target} className="size-3.5" />
            <span className="flex-1">{HARNESS_LABEL[target] ?? target}</span>
            {target === viewing.harness ? (
              <span className="text-label text-faint">same agent</span>
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
