import { z } from "zod"
import {
  BrowserConnection,
  type BrowserProtocolEvent,
} from "./browser-connection.js"
import { BrowserFault } from "./contracts/browser-control.js"
import type { JsonObject } from "./codex-app-json.js"

const rectangle = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
})
const viewport = z.object({
  pageX: z.number(),
  pageY: z.number(),
  clientWidth: z.number().positive(),
  clientHeight: z.number().positive(),
})
export async function screenshotGeometry(
  connection: BrowserConnection,
  sessionId: string,
  fullPage: boolean,
  signal: AbortSignal
) {
  const metrics = z
    .object({ cssContentSize: rectangle, cssVisualViewport: viewport })
    .parse(
      await connection.send("Page.getLayoutMetrics", {}, signal, sessionId)
    )
  const visible = metrics.cssVisualViewport
  const area = fullPage
    ? metrics.cssContentSize
    : {
        x: visible.pageX,
        y: visible.pageY,
        width: visible.clientWidth,
        height: visible.clientHeight,
      }
  const density = z
    .object({ result: z.object({ value: z.number().positive().max(16) }) })
    .parse(
      await connection.send(
        "Runtime.evaluate",
        { expression: "window.devicePixelRatio", returnByValue: true },
        signal,
        sessionId
      )
    ).result.value
  const scale = Math.min(
    1 / density,
    4096 / (area.width * density),
    4096 / (area.height * density),
    Math.sqrt(16_000_000 / (area.width * area.height)) / density
  )
  return { clip: { ...area, scale }, viewport: visible }
}

/** Subscribe before navigation so even a cached document cannot outrun the waiter. */
export async function navigatePage(
  connection: BrowserConnection,
  sessionId: string,
  url: string,
  signal: AbortSignal,
  waitUntil: "load" | "commit" = "load"
): Promise<JsonObject> {
  await connection.send(
    "Page.setLifecycleEventsEnabled",
    { enabled: true },
    signal,
    sessionId
  )
  const events: BrowserProtocolEvent[] = []
  let wake: (() => void) | undefined
  const unsubscribe = connection.onEvent((event) => {
    if (event.sessionId !== sessionId || event.method !== "Page.lifecycleEvent")
      return
    events.push(event)
    if (events.length > 128) events.shift()
    wake?.()
  })
  const active = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  const disconnected = new AbortController()
  const removeClose = connection.onClose(() => disconnected.abort())
  const waiting = AbortSignal.any([active, disconnected.signal])
  try {
    const result = await connection.send(
      "Page.navigate",
      { url },
      active,
      sessionId
    )
    const navigation = z
      .object({
        frameId: z.string(),
        loaderId: z.string().optional(),
        errorText: z.string().optional(),
        isDownload: z.boolean().optional(),
      })
      .parse(result)
    if (navigation.errorText)
      throw new BrowserFault({
        code: "protocol-error",
        message: navigation.errorText,
        outcome: "rejected",
      })
    if (!navigation.loaderId || navigation.isDownload)
      return {
        ...result,
        completion: navigation.isDownload ? "download" : "same-document",
      }
    if (waitUntil === "commit") return { ...result, completion: "commit" }
    const loaded = () =>
      events.some(
        (event) =>
          event.params.loaderId === navigation.loaderId &&
          event.params.frameId === navigation.frameId &&
          event.params.name === "load"
      )
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        waiting.removeEventListener("abort", abort)
        reject(
          new BrowserFault({
            code: "outcome-unknown",
            message:
              "Navigation was dispatched but load completion was not observed. Observe the target before continuing.",
            outcome: "unknown",
          })
        )
      }
      wake = () => {
        if (loaded()) {
          waiting.removeEventListener("abort", abort)
          resolve()
        }
      }
      waiting.addEventListener("abort", abort, { once: true })
      if (waiting.aborted) abort()
      else wake()
    })
    return { ...result, completion: "load" }
  } finally {
    unsubscribe()
    removeClose()
  }
}
