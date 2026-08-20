import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Exchange } from "@/components/transcript/exchange"
import { NAVIGATOR_WIDTH, TurnNavigator } from "@/components/transcript/turn-navigator"
import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Action, IconAction } from "@/components/ui/kit"
import {
  setComposerHarness,
  threadStatus,
  threads,
  useThreads,
  type ThreadStatus,
} from "@/state/threads"
import type { Exchange as ExchangeData } from "@/lib/exchanges"
import type { Thread } from "@/lib/types"
import { threadToMessages } from "@/lib/foreign-thread"
import {
  ArrowRightLeftIcon,
  CheckIcon,
  Loader2Icon,
  LockKeyholeIcon,
  RadioIcon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

/**
 * A conversation from another harness, opened as a conversation.
 *
 * This takes the transcript's place in the chat column — not a modal, not a
 * popup — and renders through the same prompt cards, markdown prose, and
 * tool rows every native conversation uses, because a conversation is a
 * conversation and only the mark in the corner should say where it
 * happened. The one composer below routes to this session's own harness
 * while it is open; the header holds ownership and agent controls. X or Escape
 * gives the native chat back.
 */

type ViewedThread = Thread & {
  streamRevision?: number
  streamReplaceFrom?: number
}

interface ExchangeCache {
  path: string | null
  revision: number
  count: number
  exchanges: ExchangeData[]
  entryToExchange: number[]
}

function emptyExchangeCache(
  path: string | null = null,
  revision = 0
): ExchangeCache {
  return {
    path,
    revision,
    count: 0,
    exchanges: [],
    entryToExchange: [],
  }
}

/**
 * One conversation's incremental exchange builder.
 *
 * The closure is owned by a single Conversation instance. Repeated calls with
 * the same input are idempotent, while an append converts only the new suffix
 * and a streamed replacement rebuilds only the exchange containing the edit.
 */
function createExchangeBuilder() {
  let built = emptyExchangeCache()

  return (thread: ViewedThread | null): ExchangeData[] => {
    if (!thread) {
      built = emptyExchangeCache()
      return built.exchanges
    }

    const { entries } = thread
    const revision = thread.streamRevision ?? 0
    if (built.path !== thread.ref.path || entries.length < built.count) {
      built = emptyExchangeCache(thread.ref.path, revision)
    } else if (built.revision !== revision) {
      const replaceFrom = thread.streamReplaceFrom ?? 0
      const exchangeIndex = built.entryToExchange[replaceFrom] ?? 0
      let entryStart = replaceFrom
      while (
        entryStart > 0 &&
        built.entryToExchange[entryStart - 1] === exchangeIndex
      ) {
        entryStart -= 1
      }
      built = {
        path: thread.ref.path,
        revision,
        count: entryStart,
        exchanges: built.exchanges.slice(0, exchangeIndex),
        entryToExchange: built.entryToExchange.slice(0, entryStart),
      }
    }

    if (entries.length === built.count) return built.exchanges

    let next = built.exchanges
    const entryToExchange = [...built.entryToExchange]
    for (
      let entryIndex = built.count;
      entryIndex < entries.length;
      entryIndex += 1
    ) {
      const fresh = threadToMessages([entries[entryIndex]!], entryIndex)
      for (const message of fresh) {
        if (message.role === "user") {
          next = [
            ...next,
            {
              id: message.id,
              prompt: message,
              response: [],
              system: [],
              timestamp: message.timestamp,
            },
          ]
          continue
        }

        const last = next.at(-1)
        if (!last) {
          next = [
            message.role === "system"
              ? {
                  id: `lead-${message.id}`,
                  response: [],
                  system: [message],
                  timestamp: message.timestamp,
                }
              : {
                  id: `lead-${message.id}`,
                  response: [message],
                  system: [],
                  timestamp: message.timestamp,
                },
          ]
          continue
        }

        const grown =
          message.role === "system"
            ? { ...last, system: [...last.system, message] }
            : { ...last, response: [...last.response, message] }
        next = [...next.slice(0, -1), grown]
      }
      entryToExchange[entryIndex] = Math.max(0, next.length - 1)
    }

    built = {
      path: thread.ref.path,
      revision,
      count: entries.length,
      exchanges: next,
      entryToExchange,
    }
    return next
  }
}

export function ThreadViewer() {
  const thread = useThreads((state) => state.viewing)
  const busy = useThreads((state) => state.viewingBusy)

  useEffect(() => {
    if (!thread) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
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
      <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
        <Loader2Icon className="size-5 animate-spin text-faint" />
      </div>
    )
  }
  if (!thread) return null

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col bg-surface">
      <SessionBar />
      <Conversation key={thread.ref.path} />
    </div>
  )
}

function SessionBar() {
  const thread = useThreads((state) => state.viewing)
  const sessionStatus = useThreads((state) =>
    thread ? threadStatus(thread.ref, state) : null
  )
  if (!thread || !sessionStatus) return null
  const locked =
    sessionStatus.kind === "external-open" ||
    sessionStatus.kind === "external-active"
  const status = statusLabel(sessionStatus, thread.ref.archived === true)
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3.5">
      <HarnessIcon harness={thread.ref.harness} className="size-3.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-foreground/90">
          {thread.ref.title ?? "Untitled session"}
        </p>
        <p
          title={
            locked
              ? "This session is owned by another client. Its approvals stay there while Mako follows native updates."
              : undefined
          }
          className="flex items-center gap-1 truncate text-label text-faint"
        >
          <SessionStatusIcon status={sessionStatus} />
          {status}
        </p>
      </div>
      <Action
        size="xs"
        disabled={locked}
        aria-label={`Continue with ${harnessLabel(thread.ref.harness)}`}
        title={
          locked
            ? "This native session is owned by another app"
            : `Resume with ${harnessLabel(thread.ref.harness)}`
        }
        onClick={() => {
          setComposerHarness(thread.ref.harness)
          window.dispatchEvent(new CustomEvent("mako:focus-composer"))
        }}
      >
        Continue here
      </Action>
      <Action
        size="xs"
        aria-label="Change the agent for the next message"
        title="Continue in a new session; this one stays unchanged"
        onClick={() =>
          window.dispatchEvent(new CustomEvent("mako:pick-agent"))
        }
      >
        <ArrowRightLeftIcon />
        Change agent…
      </Action>
      <IconAction
        label="Close session"
        side="bottom"
        size="xs"
        onClick={() => threads.closeViewer()}
      >
        <XIcon />
      </IconAction>
    </div>
  )
}

function statusLabel(status: ThreadStatus, archived: boolean): string {
  switch (status.kind) {
    case "working":
      return status.detail ?? "Working"
    case "needs-permission":
      return status.detail ? `Needs input · ${status.detail}` : "Needs input"
    case "failed":
      return status.detail ? `Failed · ${status.detail}` : "Failed"
    case "review":
      return status.unread ? "Finished · ready for review" : "Ready for review"
    case "observed":
      return "Live activity"
    case "external-open":
      return "Open in another app"
    case "external-active":
      return "Live in another app"
    case "idle":
      return archived ? "Archived history" : "Ready to resume"
  }
}

function SessionStatusIcon({ status }: { status: ThreadStatus }) {
  switch (status.kind) {
    case "working":
      return <Loader2Icon className="size-3 shrink-0 animate-spin text-ember/80" />
    case "needs-permission":
      return <ShieldQuestionIcon className="size-3 shrink-0 text-caution" />
    case "failed":
      return <TriangleAlertIcon className="size-3 shrink-0 text-negative" />
    case "review":
      return <CheckIcon className="size-3 shrink-0 text-positive" />
    case "observed":
      return <RadioIcon className="size-3 shrink-0" />
    case "external-open":
    case "external-active":
      return <LockKeyholeIcon className="size-3 shrink-0" />
    case "idle":
      return null
  }
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
  const run = useThreads((state) => state.run)
  const scroller = useRef<HTMLDivElement | null>(null)
  const pane = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [showEarlier, setShowEarlier] = useState(false)
  const [buildExchanges] = useState(() => createExchangeBuilder())

  /*
   * Incremental conversion — the difference between streaming and replay.
   *
   * The state-owned builder is stable for this component's lifetime. Entries
   * only ever append, so each batch converts ONLY the new tail and replaces at
   * most the last exchange. Every earlier exchange keeps its object identity,
   * letting memoized rows skip their render.
   */
  const exchanges = useMemo(() => buildExchanges(thread), [buildExchanges, thread])

  const renderedExchanges = showEarlier ? exchanges : exchanges.slice(-30)

  // Which turn is in view — the navigator's cursor. Same observer the
  // native transcript uses: costs nothing while entries stream in.
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        const id = visible?.target.getAttribute("data-exchange")
        if (id) setActiveTurn(id)
      },
      { root: node, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    )
    for (const element of node.querySelectorAll("[data-exchange]")) observer.observe(element)
    return () => observer.disconnect()
  }, [renderedExchanges.length])

  const jump = (id: string) => {
    stick.current = false
    scroller.current
      ?.querySelector(`[data-exchange="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" })
  }

  // A conversation opens at its end — that is where the conversation is.
  // Before paint, so the reader never sees the top flash by; and pinned
  // through late growth (markdown, code blocks, images settling) by
  // watching the content's own height, not just entry counts.
  useLayoutEffect(() => {
    stick.current = true
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [thread?.ref.path])

  useEffect(() => {
    const node = scroller.current
    if (!node) return
    const pin = () => {
      if (stick.current) node.scrollTop = node.scrollHeight
    }
    pin()
    const grown = new ResizeObserver(pin)
    if (node.firstElementChild) grown.observe(node.firstElementChild)
    return () => grown.disconnect()
  }, [thread?.ref.path, renderedExchanges.length])

  useEffect(() => {
    const node = scroller.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [renderedExchanges.length, thread?.entries.length])

  return (
    <div ref={pane} className="relative flex min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        style={{ paddingRight: NAVIGATOR_WIDTH }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {exchanges.length === 0 ? (
          <p className="pt-12 text-center text-ui text-faint">
            This session has no readable conversation.
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-content flex-col gap-7 px-6 py-6">
            {!showEarlier && exchanges.length > renderedExchanges.length ? (
              <button
                type="button"
                onClick={() => setShowEarlier(true)}
                className="pressable self-center rounded-md bg-raised px-2.5 py-1 text-label text-faint hover:text-foreground"
              >
                Show {exchanges.length - renderedExchanges.length} earlier turns
              </button>
            ) : null}
            {renderedExchanges.map((exchange) => (
              <Exchange key={exchange.id} exchange={exchange} />
            ))}
            {run?.status === "running" && thread ? (
              <div className="animate-enter flex items-center gap-2 px-0.5 text-ui">
                <HarnessIcon
                  harness={thread.ref.harness}
                  className="size-3.5 animate-live"
                />
                <span className="shimmer">
                  {harnessLabel(thread.ref.harness)} is working…
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <TurnNavigator
        exchanges={renderedExchanges}
        activeId={activeTurn}
        onJump={jump}
        paneRef={pane}
      />
    </div>
  )
}

