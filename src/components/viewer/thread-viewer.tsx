import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Exchange } from "@/components/transcript/exchange"
import { NAVIGATOR_WIDTH, TurnNavigator } from "@/components/transcript/turn-navigator"
import { harnessLabel } from "@/components/rail/agent-threads"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { threads, useThreads } from "@/state/threads"
import type { Exchange as ExchangeData } from "@/lib/exchanges"
import { threadToMessages } from "@/lib/foreign-thread"
import { Loader2Icon } from "lucide-react"

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

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col bg-background">

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
  const run = useThreads((state) => state.run)
  const scroller = useRef<HTMLDivElement | null>(null)
  const pane = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)

  /*
   * Incremental conversion — the difference between streaming and replay.
   *
   * Entries only ever append (a rewriting store arrives as a fresh thread
   * object and resets the cache), so each batch converts ONLY the new tail
   * and replaces at most the last exchange. Every earlier exchange keeps
   * its object identity, the memoized rows skip their re-render, and a
   * token batch costs the last turn's paint instead of the whole
   * conversation's markdown being re-parsed — which is what made long
   * sessions feel like replay instead of streaming.
   */
  const built = useRef<{ path: string | null; revision: number; count: number; exchanges: ExchangeData[] }>({
    path: null,
    revision: 0,
    count: 0,
    exchanges: [],
  })
  const exchanges = useMemo(() => {
    if (!thread) {
      built.current = { path: null, revision: 0, count: 0, exchanges: [] }
      return []
    }
    const { entries } = thread
    const revision = (thread as typeof thread & { streamRevision?: number }).streamRevision ?? 0
    if (
      built.current.path !== thread.ref.path ||
      built.current.revision !== revision ||
      entries.length < built.current.count
    ) {
      built.current = { path: thread.ref.path, revision, count: 0, exchanges: [] }
    }
    const cache = built.current
    if (entries.length === cache.count) return cache.exchanges
    const fresh = threadToMessages(entries.slice(cache.count), cache.count)
    let next = cache.exchanges
    for (const message of fresh) {
      if (message.role === "user") {
        next = [
          ...next,
          { id: message.id, prompt: message, response: [], system: [], timestamp: message.timestamp },
        ]
        continue
      }
      const last = next.at(-1)
      if (!last) {
        next = [
          message.role === "system"
            ? { id: `lead-${message.id}`, response: [], system: [message], timestamp: message.timestamp }
            : { id: `lead-${message.id}`, response: [message], system: [], timestamp: message.timestamp },
        ]
        continue
      }
      const grown =
        message.role === "system"
          ? { ...last, system: [...last.system, message] }
          : { ...last, response: [...last.response, message] }
      next = [...next.slice(0, -1), grown]
    }
    built.current = { path: thread.ref.path, revision, count: entries.length, exchanges: next }
    return next
  }, [thread])

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
  }, [exchanges.length])

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
  }, [thread?.ref.path, exchanges.length])

  useEffect(() => {
    const node = scroller.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [exchanges.length, thread?.entries.length])

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
          <p className="pt-12 text-center text-[12px] text-faint">
            This session has no readable conversation.
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-6 py-6">
            {exchanges.map((exchange) => (
              <Exchange key={exchange.id} exchange={exchange} />
            ))}
            {run?.status === "running" && thread ? (
              <div className="animate-enter flex items-center gap-2 px-0.5 text-[12px]">
                <HarnessIcon
                  harness={thread.ref.harness}
                  className="size-3.5 animate-pulse"
                />
                <span className="shimmer">
                  {harnessLabel(thread.ref.harness)} is working…
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <TurnNavigator exchanges={exchanges} activeId={activeTurn} onJump={jump} paneRef={pane} />
    </div>
  )
}

