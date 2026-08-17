import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Exchange } from "@/components/transcript/exchange"
import { NAVIGATOR_WIDTH, TurnNavigator } from "@/components/transcript/turn-navigator"
import { Slot } from "@/extend/slot"
import { toExchanges } from "@/lib/exchanges"
import { foldTools } from "@/lib/tools"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import { ArrowDownIcon, ArrowUpIcon, TerminalIcon } from "lucide-react"

const NEAR_BOTTOM = 96

/**
 * The transcript scroller.
 *
 * Autoscroll follows the stream only while the reader is already at the
 * bottom; the moment they scroll up to read something, the view stops moving
 * under them and offers an explicit way back.
 */
export function Transcript() {
  const messages = useSession((state) => state.messages)
  const stream = useSession((state) => state.stream)
  // Only the session identity — subscribing to the whole meta object would
  // re-render the list on every token-count update.
  const sessionId = useSession((state) => state.meta?.sessionId)

  const pane = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)

  const exchanges = useMemo(() => {
    const list = toExchanges(foldTools(messages))
    if (!stream) return list
    // The in-flight message belongs to the exchange it is answering.
    const last = list.at(-1)
    if (!last) return [{ id: "draft", response: [stream], system: [] }]
    return [...list.slice(0, -1), { ...last, response: [...last.response, stream] }]
  }, [messages, stream])

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = viewport.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior })
    pinned.current = true
    setShowJump(false)
  }, [])

  const onScroll = useCallback(() => {
    const node = viewport.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const atBottom = distance < NEAR_BOTTOM
    pinned.current = atBottom
    setShowJump((current) => (current === !atBottom ? current : !atBottom))
  }, [])

  // Which turn is in view, for the navigator. An observer rather than a scroll
  // handler, so tracking the reading position costs nothing while tokens land.
  useEffect(() => {
    const node = viewport.current
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

  // Layout effect so the pin happens in the same frame the content grew —
  // otherwise the reader sees a one-frame jump on every token.
  useLayoutEffect(() => {
    if (pinned.current) {
      const node = viewport.current
      if (node) node.scrollTop = node.scrollHeight
    }
  }, [exchanges])

  // A different session is a different reading position: start at the end.
  useEffect(() => {
    pinned.current = true
    scrollToEnd()
  }, [sessionId, scrollToEnd])

  const jump = useCallback((id: string) => {
    viewport.current
      ?.querySelector(`[data-exchange="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  // ⌘↑ / ⌘↓ step between questions without reaching for the pointer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
      if (exchanges.length === 0) return
      event.preventDefault()
      const at = exchanges.findIndex((exchange) => exchange.id === activeTurn)
      const from = at < 0 ? exchanges.length - 1 : at
      const next = Math.min(
        exchanges.length - 1,
        Math.max(0, from + (event.key === "ArrowDown" ? 1 : -1))
      )
      jump(exchanges[next].id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [activeTurn, exchanges, jump])

  const empty = exchanges.length === 0
  const showNavigator = !empty && exchanges.length >= 3

  return (
    <div ref={pane} className="relative flex min-h-0 flex-1 flex-col">
      <Slot name="transcript.header" meta={undefined} />

      <div
        ref={viewport}
        onScroll={onScroll}
        // The navigator's gutter is reserved here rather than overlaid, so the
        // centred column shifts left instead of running underneath the ticks.
        style={{ paddingInlineEnd: showNavigator ? NAVIGATOR_WIDTH : 0 }}
        className="transcript-field group/transcript min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {empty ? (
          <EmptyTranscript />
        ) : (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-6 py-6">
            {exchanges.map((exchange, index) => (
              <Exchange
                key={exchange.id}
                exchange={exchange}
                streaming={Boolean(stream) && index === exchanges.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {showNavigator ? (
        <TurnNavigator
          exchanges={exchanges}
          activeId={activeTurn}
          onJump={jump}
          paneRef={pane}
        />
      ) : null}

      <button
        type="button"
        onClick={() => scrollToEnd("smooth")}
        aria-hidden={!showJump}
        tabIndex={showJump ? 0 : -1}
        style={{ left: `calc(50% - ${showNavigator ? NAVIGATOR_WIDTH / 2 : 0}px)` }}
        className={cn(
          "pressable absolute bottom-3 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full",
          "bg-raised px-3 text-[11.5px] text-muted-foreground ring-1 ring-hairline",
          "[transition:opacity_180ms_var(--ease-out),transform_180ms_var(--ease-out)]",
          showJump
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none translate-y-1 opacity-0"
        )}
      >
        <ArrowDownIcon className="size-3" />
        Jump to latest
      </button>
    </div>
  )
}

/**
 * The opening screen carries the one fact worth knowing before you type —
 * which folder the agent is pointed at — and three concrete openers. The
 * openers fill the composer rather than sending, so the first message is
 * still the user's.
 */
function EmptyTranscript() {
  const cwd = useSession((state) => state.meta?.cwd)

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-[440px] pb-12">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-raised text-faint">
            <TerminalIcon className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">Start a turn</p>
            <p className="truncate font-mono text-[11px] text-faint" title={cwd}>
              {cwd ?? "no workspace"}
            </p>
          </div>
        </div>

        <Slot name="transcript.empty" meta={undefined} />

        <div className="mt-4 flex flex-col">
          {SUGGESTIONS.map((suggestion, index) => (
            <Suggestion key={suggestion} text={suggestion} index={index} />
          ))}
        </div>
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  "Explain how this project is structured",
  "Review my uncommitted changes",
  "Find and fix the failing test",
]

function Suggestion({ text, index }: { text: string; index: number }) {
  return (
    <button
      type="button"
      // A short stagger on first paint; the list reads as arriving rather than
      // as having always been there. 45ms apart stays under the threshold
      // where waiting becomes perceptible.
      style={{ animationDelay: `${60 + index * 45}ms` }}
      onClick={() => window.dispatchEvent(new CustomEvent("pi:compose", { detail: text }))}
      className={cn(
        "pressable group flex w-full animate-enter items-center gap-2 rounded-md border-t border-hairline",
        "px-2 py-2 text-left text-[12.5px] text-muted-foreground",
        "[transition:transform_var(--duration-press)_var(--ease-out),color_120ms_ease,background-color_120ms_ease]",
        "first:border-t-0 hover:bg-raised hover:text-foreground"
      )}
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <ArrowUpIcon className="size-3 shrink-0 rotate-45 text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
    </button>
  )
}
