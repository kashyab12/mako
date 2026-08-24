import type { ReactNode, WheelEvent as ReactWheelEvent } from "react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { Exchange } from "@/components/transcript/exchange"
import {
  NAVIGATOR_WIDTH,
  TurnNavigator,
} from "@/components/transcript/turn-navigator"
import type { Exchange as ExchangeData } from "@/lib/exchanges"
import { cn } from "@/lib/utils"
import { ArrowDownIcon, ChevronUpIcon } from "lucide-react"

const NEAR_BOTTOM = 96

/**
 * How many turns are mounted when a session opens, and how many more each
 * "show earlier" reveals. Thirty covers more than a screenful while avoiding
 * hundreds of synchronous Markdown parses for a large session.
 */
const INITIAL_TURNS = 30
const MORE_TURNS = 30

interface ScrollAnchor {
  exchangeId?: string
  exchangeOffset?: number
  scrollHeight: number
  scrollTop: number
  shown: number
}

function holdPrependedHeights(node: HTMLDivElement, exchangeId?: string) {
  if (!exchangeId) return
  for (const element of node.querySelectorAll("[data-exchange]")) {
    if (element.getAttribute("data-exchange") === exchangeId) break
    element.setAttribute("data-preserve-height", "")
  }
}

function preserveScrollAnchor(node: HTMLDivElement, snapshot: ScrollAnchor) {
  const anchor = snapshot.exchangeId
    ? node.querySelector(`[data-exchange="${CSS.escape(snapshot.exchangeId)}"]`)
    : null
  if (anchor && snapshot.exchangeOffset !== undefined) {
    const offset =
      anchor.getBoundingClientRect().top - node.getBoundingClientRect().top
    node.scrollTop += offset - snapshot.exchangeOffset
  } else {
    node.scrollTop =
      snapshot.scrollTop + (node.scrollHeight - snapshot.scrollHeight)
  }
}

/**
 * The provider-neutral conversation scroller. It follows a stream only while
 * the reader is already at the bottom and preserves their place when older
 * turns are prepended.
 */
export function ConversationTimeline({
  identity,
  exchanges,
  streamingId,
  interruptedId,
  failedId,
  empty,
  footer,
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
}: {
  identity: string
  exchanges: ExchangeData[]
  streamingId?: string
  interruptedId?: string
  failedId?: string
  empty: ReactNode
  footer?: ReactNode
  hasEarlier?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => Promise<void>
}) {
  const pane = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const topFade = useRef<HTMLSpanElement>(null)
  const pinned = useRef(true)
  const lastScrollTop = useRef(0)
  const restore = useRef<ScrollAnchor | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [limit, setLimit] = useState(INITIAL_TURNS)
  const hidden = Math.max(0, exchanges.length - limit)
  const shown = hidden > 0 ? exchanges.slice(hidden) : exchanges
  const isEmpty = exchanges.length === 0

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = viewport.current
    if (!node) return
    restore.current = null
    node.scrollTo({ top: node.scrollHeight, behavior })
    lastScrollTop.current = node.scrollHeight
    pinned.current = true
    setShowJump(false)
  }, [])

  const onScroll = useCallback(() => {
    const node = viewport.current
    if (!node) return
    topFade.current?.toggleAttribute("data-scrolled", node.scrollTop > 0.5)
    const movingUp = node.scrollTop < lastScrollTop.current - 0.5
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const atBottom = distance < NEAR_BOTTOM
    pinned.current = !movingUp && atBottom
    lastScrollTop.current = node.scrollTop
    setShowJump((current) => (current === !atBottom ? current : !atBottom))
  }, [])

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    restore.current = null
    if (event.deltaY < 0) pinned.current = false
  }, [])

  const onPointerDown = useCallback(() => {
    restore.current = null
  }, [])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            entry.target.hasAttribute("data-preserve-height")
          ) {
            requestAnimationFrame(() =>
              entry.target.removeAttribute("data-preserve-height")
            )
          }
        }
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (left, right) =>
              left.boundingClientRect.top - right.boundingClientRect.top
          )[0]
        const id = visible?.target.getAttribute("data-exchange")
        if (id) setActiveTurn(id)
      },
      { root: node, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    )
    for (const element of node.querySelectorAll("[data-exchange]")) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [shown.length])

  useLayoutEffect(() => {
    restore.current = null
    pinned.current = true
    const node = viewport.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    lastScrollTop.current = node.scrollTop
  }, [identity])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const pin = () => {
      if (!pinned.current) {
        if (restore.current) {
          preserveScrollAnchor(node, restore.current)
          lastScrollTop.current = node.scrollTop
        }
        return
      }
      node.scrollTop = node.scrollHeight
      lastScrollTop.current = node.scrollTop
    }
    pin()
    const grown = new ResizeObserver(pin)
    if (node.firstElementChild) grown.observe(node.firstElementChild)
    return () => grown.disconnect()
  }, [identity, isEmpty])

  useLayoutEffect(() => {
    const snapshot = restore.current
    const node = viewport.current
    if (!snapshot || !node || loadingEarlier) return
    if (snapshot.shown === shown.length) return
    holdPrependedHeights(node, snapshot.exchangeId)
    preserveScrollAnchor(node, snapshot)
    lastScrollTop.current = node.scrollTop
  }, [loadingEarlier, shown.length])

  const showEarlier = useCallback(async () => {
    const node = viewport.current
    if (!node) return
    const viewportTop = node.getBoundingClientRect().top
    const anchor = Array.from(node.querySelectorAll("[data-exchange]")).find(
      (element) => element.getBoundingClientRect().bottom > viewportTop + 1
    )
    restore.current = {
      exchangeId: anchor?.getAttribute("data-exchange") ?? undefined,
      exchangeOffset: anchor
        ? anchor.getBoundingClientRect().top - viewportTop
        : undefined,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      shown: shown.length,
    }
    pinned.current = false
    node.setAttribute("data-preserve-scroll", "")
    if (hidden > 0) setLimit((current) => current + MORE_TURNS)
    else await onLoadEarlier?.()
    requestAnimationFrame(() => node.removeAttribute("data-preserve-scroll"))
  }, [hidden, onLoadEarlier, shown.length])

  const jump = useCallback((id: string) => {
    restore.current = null
    pinned.current = false
    viewport.current
      ?.querySelector(`[data-exchange="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
      if (shown.length === 0) return
      event.preventDefault()
      const at = shown.findIndex((exchange) => exchange.id === activeTurn)
      const from = at < 0 ? shown.length - 1 : at
      const offset = event.key === "ArrowDown" ? 1 : -1
      const next = Math.min(shown.length - 1, Math.max(0, from + offset))
      jump(shown[next]!.id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [activeTurn, shown, jump])

  const showNavigator = !isEmpty && shown.length >= 3

  return (
    <div
      ref={pane}
      className="scroll-fade-scope relative flex min-h-0 flex-1 flex-col"
    >
      <span ref={topFade} aria-hidden className="scroll-fade-top" />
      <div
        ref={viewport}
        onPointerDown={onPointerDown}
        onScroll={onScroll}
        onWheel={onWheel}
        style={{ paddingInlineEnd: showNavigator ? NAVIGATOR_WIDTH : 0 }}
        className="scroll-fade-scroller group/transcript min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {isEmpty ? (
          empty
        ) : (
          <div
            key={identity}
            className="animate-thread mx-auto flex w-full max-w-content flex-col gap-7 px-6 py-6"
          >
            {hidden > 0 || hasEarlier ? (
              <button
                type="button"
                disabled={loadingEarlier}
                onClick={() => void showEarlier()}
                className={cn(
                  "pressable mx-auto flex h-7 items-center gap-1.5 rounded-full bg-raised px-3",
                  "text-ui text-muted-foreground ring-1 ring-hairline",
                  "transition-colors duration-120 hover:text-foreground"
                )}
              >
                <ChevronUpIcon className="size-3" />
                {loadingEarlier
                  ? "Loading earlier turns…"
                  : hidden === 1
                    ? "Show 1 earlier turn"
                    : hidden > 1
                      ? `Show ${Math.min(hidden, MORE_TURNS)} earlier turns`
                      : "Show earlier turns"}
              </button>
            ) : null}
            {shown.map((exchange) => (
              <Exchange
                key={exchange.id}
                exchange={exchange}
                streaming={exchange.id === streamingId}
                interrupted={
                  exchange.id === interruptedId || exchangeInterrupted(exchange)
                }
                failed={exchange.id === failedId}
              />
            ))}
            {footer}
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
        style={{
          left: `calc(50% - ${showNavigator ? NAVIGATOR_WIDTH / 2 : 0}px)`,
        }}
        className={cn(
          "pressable absolute bottom-3 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full",
          "bg-raised px-3 text-ui text-muted-foreground ring-1 ring-hairline",
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

function exchangeInterrupted(exchange: ExchangeData): boolean {
  return exchange.system.some((message) =>
    message.blocks.some((block) => {
      const text = block.type === "text" ? block.text : undefined
      return text ? /^Interrupted(?:\s|$)/i.test(text.trim()) : false
    })
  )
}
