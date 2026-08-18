import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Exchange } from "@/components/transcript/exchange"
import { NAVIGATOR_WIDTH, TurnNavigator } from "@/components/transcript/turn-navigator"
import { Slot } from "@/extend/slot"
import { FirstRun } from "@/components/onboarding/first-run"
import { toExchanges } from "@/lib/exchanges"
import { foldTools } from "@/lib/tools"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  FolderIcon,
  GitCompareIcon,
  MapIcon,
} from "lucide-react"
import { MakoMark } from "@/components/ui/mako-mark"

const NEAR_BOTTOM = 96

/**
 * How many turns are mounted when a session opens, and how many more each
 * "show earlier" reveals.
 *
 * Opening a thread used to mount every exchange in one commit, and each one
 * parses its own markdown — so a 400-message session paid a couple of hundred
 * parses on the main thread before it painted anything. That is the entire
 * reason long threads felt slow to open; the IPC that carries them is not the
 * bottleneck.
 *
 * Thirty covers more than a screenful at any window size, so the window is
 * invisible unless you deliberately scroll back through a long session.
 */
const INITIAL_TURNS = 30
const MORE_TURNS = 50

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
  const [limit, setLimit] = useState(INITIAL_TURNS)

  const exchanges = useMemo(() => {
    const list = toExchanges(foldTools(messages))
    if (!stream) return list
    // The in-flight message belongs to the exchange it is answering.
    const last = list.at(-1)
    if (!last) return [{ id: "draft", response: [stream], system: [] }]
    return [...list.slice(0, -1), { ...last, response: [...last.response, stream] }]
  }, [messages, stream])

  // Declared here, before any effect that reads it: the keyboard handler and
  // the intersection observer both close over `shown`, and a `const` in the
  // temporal dead zone throws the moment one of them runs.
  const hidden = Math.max(0, exchanges.length - limit)
  const shown = hidden > 0 ? exchanges.slice(hidden) : exchanges

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
  }, [shown.length])

  // Layout effect so the pin happens in the same frame the content grew —
  // otherwise the reader sees a one-frame jump on every token.
  useLayoutEffect(() => {
    if (pinned.current) {
      const node = viewport.current
      if (node) node.scrollTop = node.scrollHeight
    }
  }, [exchanges])

  // A different session is a different reading position: start at the end, and
  // back at a small window — carrying an expanded one across would make every
  // switch after a deep scroll slow again.
  useEffect(() => {
    pinned.current = true
    setLimit(INITIAL_TURNS)
    scrollToEnd()
  }, [sessionId, scrollToEnd])

  /*
   * Reveal earlier turns without the view jumping.
   *
   * Prepending content moves everything below it down by exactly the height
   * that was added, so the reader would lose their place. Recording the scroll
   * height before the commit and restoring the difference after keeps whatever
   * they were reading under the same pixel.
   */
  const showEarlier = useCallback(() => {
    const node = viewport.current
    const before = node?.scrollHeight ?? 0
    const top = node?.scrollTop ?? 0
    pinned.current = false
    setLimit((current) => current + MORE_TURNS)
    requestAnimationFrame(() => {
      if (!node) return
      node.scrollTop = top + (node.scrollHeight - before)
    })
  }, [])

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
      if (shown.length === 0) return
      event.preventDefault()
      const at = shown.findIndex((exchange) => exchange.id === activeTurn)
      const from = at < 0 ? shown.length - 1 : at
      const next = Math.min(shown.length - 1, Math.max(0, from + (event.key === "ArrowDown" ? 1 : -1)))
      jump(shown[next].id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [activeTurn, shown, jump])

  const empty = exchanges.length === 0
  const showNavigator = !empty && shown.length >= 3

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
          <div
            // Keyed by session so the animation replays on a switch and not on
            // every token: within a session the key never changes, so a
            // streaming turn costs nothing here.
            key={sessionId ?? "none"}
            className="animate-thread mx-auto flex w-full max-w-[760px] flex-col gap-7 px-6 py-6"
          >
            {hidden > 0 ? (
              <button
                type="button"
                onClick={showEarlier}
                className={cn(
                  "pressable mx-auto flex h-7 items-center gap-1.5 rounded-full bg-raised px-3",
                  "text-[11.5px] text-muted-foreground ring-1 ring-hairline",
                  "transition-colors duration-120 hover:text-foreground"
                )}
              >
                <ChevronUpIcon className="size-3" />
                {hidden === 1 ? "Show 1 earlier turn" : `Show ${Math.min(hidden, MORE_TURNS)} earlier turns`}
              </button>
            ) : null}
            {shown.map((exchange, index) => (
              <Exchange
                key={exchange.id}
                exchange={exchange}
                streaming={Boolean(stream) && index === shown.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {showNavigator ? (
        <TurnNavigator
          exchanges={shown}
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
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-[460px] pb-16">
        <div className="flex items-center gap-3.5">
          <MakoMark className="size-8 shrink-0 text-foreground/85" />
          <div className="min-w-0">
            <p className="text-[16px] leading-tight font-semibold tracking-[-0.01em]">
              Ask for anything
            </p>
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-faint">
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

        <div className="mt-6 flex flex-col">
          {SUGGESTIONS.map((suggestion, index) => (
            <Suggestion key={suggestion.text} suggestion={suggestion} index={index} />
          ))}
        </div>

        <FirstRun />
      </div>
    </div>
  )
}

const SUGGESTIONS = [
  { text: "Explain how this project is structured", icon: MapIcon },
  { text: "Review my uncommitted changes", icon: GitCompareIcon },
  { text: "Find and fix the failing test", icon: CircleCheckIcon },
]

function Suggestion({
  suggestion,
  index,
}: {
  suggestion: (typeof SUGGESTIONS)[number]
  index: number
}) {
  const Icon = suggestion.icon

  return (
    <button
      type="button"
      // A short stagger on first paint; the list reads as arriving rather than
      // as having always been there. 45ms apart stays under the threshold
      // where waiting becomes perceptible.
      style={{ animationDelay: `${60 + index * 45}ms` }}
      onClick={() =>
        window.dispatchEvent(new CustomEvent("pi:compose", { detail: suggestion.text }))
      }
      className={cn(
        "pressable group flex w-full animate-enter items-center gap-2.5 rounded-md border-t border-hairline",
        "px-2.5 py-2.5 text-left text-[12.5px] text-muted-foreground",
        "[transition:transform_var(--duration-press)_var(--ease-out),color_120ms_ease,background-color_120ms_ease]",
        "first:border-t-0 hover:bg-raised hover:text-foreground"
      )}
    >
      <Icon className="size-3.5 shrink-0 text-faint transition-colors duration-120 group-hover:text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{suggestion.text}</span>
      <ArrowUpIcon className="size-3 shrink-0 rotate-45 text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
    </button>
  )
}
