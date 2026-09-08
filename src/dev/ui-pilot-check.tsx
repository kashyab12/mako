import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import type { Exchange as ExchangeData } from "@/lib/exchanges"
// Explicit fixture page: /scripts/ui-pilot-browser.html. Never imported by Mako.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Prose } from "@/components/transcript/markdown"
import { Divider } from "@/components/shell/divider"
import { DitherField } from "@/components/ui/dither-field"
import { Transcript } from "@/components/transcript/transcript"
import { Composer } from "@/components/composer/composer"
import { store as sessionStore } from "@/state/session"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()
const page = document.getElementById("root")!
page.className = "p-8 text-ui"
const button = document.createElement("button")
button.className =
  "pressable rounded-md bg-primary px-3 py-2 text-primary-foreground"
button.textContent = "Run UI regression checks"
const output = document.createElement("pre")
output.className = "my-4 whitespace-pre-wrap text-ui"
output.textContent =
  "Tests use the production components and a fixture clipboard. No agent is started."
const fixture = document.createElement("div")
// Keep visibility-sensitive components onscreen as the result log grows.
fixture.className = "fixed bottom-0 right-0 isolate w-full max-w-content"
page.append(button, output, fixture)
const root = createRoot(fixture)

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
  output.textContent += `\nPASS ${message}`
}

async function until(test: () => boolean) {
  const deadline = performance.now() + 3000
  while (!test()) {
    if (performance.now() > deadline) throw new Error("UI condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function openingDraft() {
  sessionStore.set({ messages: [], stream: null })
  flushSync(() =>
    root.render(
      <TooltipProvider>
        <main className="agent-surface relative isolate flex h-[640px] flex-col overflow-hidden">
          <Transcript />
          <Composer />
        </main>
      </TooltipProvider>
    )
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  const scene = fixture.querySelector<HTMLElement>(".ocean-scene")
  const heading = fixture.querySelector<HTMLElement>(".text-welcome")
  const input = fixture.querySelector<HTMLTextAreaElement>(".composer-input")
  check(scene !== null, "the empty transcript mounts its artwork")
  check(heading !== null, "the empty transcript mounts its heading")
  check(input !== null, "the empty transcript mounts its composer")
  const pane = fixture.querySelector("main")!
  const paneTop = () => pane.getBoundingClientRect().top
  const bounds = scene.getBoundingClientRect()
  const sceneTop = bounds.top - paneTop()
  const headingTop = heading.getBoundingClientRect().top - paneTop()
  const inputHeight = input.getBoundingClientRect().height
  input.focus({ preventScroll: true })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  check(
    input.getBoundingClientRect().height === inputHeight,
    "focusing an empty composer does not change its height"
  )
  for (const lines of [1, 12, 30]) {
    window.dispatchEvent(
      new CustomEvent("mako:compose", {
        detail: Array.from(
          { length: lines },
          (_, i) => `Layout check ${i + 1}`
        ).join("\n"),
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    const current = scene.getBoundingClientRect()
    check(
      current.top - paneTop() === sceneTop && current.height === bounds.height,
      `the ocean stays fixed with a ${lines}-line draft`
    )
    check(
      heading.getBoundingClientRect().top - paneTop() === headingTop,
      `the opening heading stays fixed with a ${lines}-line draft`
    )
  }
  window.dispatchEvent(new CustomEvent("mako:compose", { detail: "" }))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  flushSync(() => root.render(null))
}

async function paragraphs() {
  await document.fonts.ready
  const text =
    "A paragraph keeps its native text selection and browser line breaking while an estimate reserves space. ".repeat(
      35
    )
  for (const width of [360, 640, 900]) {
    const previous = fixture.querySelector("p")?.style.containIntrinsicBlockSize
    flushSync(() =>
      root.render(
        <div style={{ width }}>
          <Prose text={text} />
        </div>
      )
    )
    const paragraph = fixture.querySelector("p")!
    await until(
      () =>
        paragraph.style.containIntrinsicBlockSize !== "" &&
        paragraph.style.containIntrinsicBlockSize !== previous
    )
    const intrinsic = Number.parseFloat(
      paragraph.style.containIntrinsicBlockSize.replace("auto ", "")
    )
    const line = Number.parseFloat(getComputedStyle(paragraph).lineHeight)
    const actual = paragraph.getBoundingClientRect().height
    check(
      Math.abs(intrinsic - actual) <= line * 2 + 1,
      `native paragraph and estimate agree within two lines at ${width}px`
    )
    check(
      paragraph.textContent === text.trimEnd(),
      "paragraph text is unchanged"
    )
  }
  flushSync(() => root.render(<Prose text={text} streaming />))
  await until(
    () => !fixture.querySelector("p")?.hasAttribute("data-estimated-paragraph")
  )
  check(
    fixture.querySelector("p")?.style.containIntrinsicBlockSize === "",
    "streaming disables preparation and estimates"
  )
  flushSync(() =>
    root.render(
      <Prose
        text={`**Styled text** ${text}\n\n| Column | Value |\n| --- | --- |\n| Row | Native table |`}
      />
    )
  )
  check(
    fixture.querySelector("p")?.style.containIntrinsicBlockSize === "",
    "styled paragraphs stay entirely native"
  )
  check(
    fixture.querySelectorAll("table").length === 1,
    "GFM still renders as a real table"
  )
}

function deferred() {
  let resolve: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve() }
}

async function transcriptAnchor() {
  const exchanges: ExchangeData[] = Array.from({ length: 60 }, (_, index) => ({
    id: `exchange-${index}`,
    system: [],
    response: [
      {
        id: `answer-${index}`,
        role: "assistant",
        blocks: [
          {
            type: "text",
            text: "The browser keeps the actual paragraph layout while earlier turns are inserted above the reading position. ".repeat(
              12
            ),
          },
        ],
      },
    ],
  }))
  flushSync(() =>
    root.render(
      <div className="flex h-96 flex-col" style={{ width: 640 }}>
        <ConversationTimeline
          identity="geometry-check"
          exchanges={exchanges}
          empty={null}
        />
      </div>
    )
  )
  const scroller = fixture.querySelector<HTMLDivElement>(
    ".scroll-fade-scroller"
  )!
  // Open the thread fully before measuring a user's established reading position.
  await new Promise((resolve) => setTimeout(resolve, 300))
  scroller.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -100, bubbles: true })
  )
  scroller.scrollTop = 0
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const anchor = fixture.querySelector<HTMLElement>(
    '[data-exchange="exchange-30"]'
  )!
  const offset = () =>
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const before = offset()
  const earlier = [...fixture.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("Show 30 earlier turns")
  )!
  earlier.click()
  await until(
    () => fixture.querySelector('[data-exchange="exchange-0"]') !== null
  )
  await new Promise((resolve) => setTimeout(resolve, 160))
  check(
    Math.abs(offset() - before) <= 2,
    `prepending thirty real exchanges preserves the reading anchor within 2px (${Math.abs(offset() - before).toFixed(2)}px)`
  )
  const paragraph = fixture.querySelector("[data-preserve-height] p")!
  check(
    getComputedStyle(paragraph).contentVisibility === "visible",
    "paragraph estimates yield to the transcript's scroll-preservation guard"
  )
}

async function clipboard() {
  const bridge = window.mako!
  const original = bridge.copy
  const source = (text: string) => (
    <>
      <Prose text={`\`\`\`text\n${text}\n\`\`\``} />
      <Toaster />
    </>
  )
  try {
    const pending = deferred()
    bridge.copy = () => pending.promise
    flushSync(() => root.render(source("first")))
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    check(
      !fixture.textContent?.includes("Copied"),
      "copy is not confirmed while the clipboard is pending"
    )
    pending.resolve()
    await until(() => Boolean(fixture.textContent?.includes("Copied")))
    check(true, "copy confirms after the clipboard succeeds")
    const label = fixture.querySelector(".changing-label")!
    check(
      getComputedStyle(label).animationName ===
        (matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "none"
          : "label-arrive"),
      "label motion uses the production stylesheet and respects reduced motion"
    )

    const stale = deferred()
    bridge.copy = () => stale.promise
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    flushSync(() => root.render(source("different text")))
    stale.resolve()
    await new Promise((resolve) => setTimeout(resolve, 40))
    check(
      !fixture.textContent?.includes("Copied"),
      "a stale copy cannot confirm replacement text"
    )

    bridge.copy = () => Promise.reject(new Error("fixture clipboard refusal"))
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    await until(() => Boolean(fixture.textContent?.includes("Could not copy")))
    check(
      !fixture.textContent?.includes("Copied"),
      "clipboard refusal never reports success"
    )
    check(
      Boolean(fixture.textContent?.includes("Retry")),
      "clipboard failure offers retry"
    )
    await new Promise((resolve) => setTimeout(resolve, 4200))
    check(
      Boolean(fixture.textContent?.includes("Could not copy")),
      "actionable failure survives the default toast timeout"
    )
    bridge.copy = () => Promise.resolve()
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    await until(
      () =>
        Boolean(fixture.textContent?.includes("Copied")) &&
        !fixture.textContent?.includes("Could not copy")
    )
    check(true, "a successful retry clears the obsolete failure")
  } finally {
    bridge.copy = original
  }
}

async function divider() {
  let resized = 300
  let committed = 300
  flushSync(() =>
    root.render(
      <Divider
        side="right"
        size={300}
        min={200}
        max={500}
        onResize={(value) => {
          resized = value
        }}
        onCommit={(value) => {
          committed = value
        }}
      />
    )
  )
  const handle = fixture.querySelector<HTMLElement>("[role=separator]")!
  handle.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
  )
  check(
    resized === 310 && committed === 310,
    "keyboard resize commits a ten-pixel step"
  )
  // Synthetic pointer events do not allocate a native pointer. Stub only capture;
  // the production event handlers, RAF, body cleanup and React teardown run intact.
  let captured = false
  handle.setPointerCapture = () => {
    captured = true
  }
  handle.hasPointerCapture = () => captured
  handle.releasePointerCapture = () => {
    captured = false
  }
  const cursor = document.body.style.cursor
  const selection = document.body.style.userSelect
  const pointer = { pointerId: 1, isPrimary: true, button: 0, bubbles: true }
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { ...pointer, clientX: 300 })
  )
  handle.dispatchEvent(
    new PointerEvent("pointermove", { ...pointer, clientX: 200 })
  )
  flushSync(() => root.render(null))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  check(
    document.body.style.cursor === cursor &&
      document.body.style.userSelect === selection &&
      !captured,
    "unmount during a drag releases capture and restores body interaction"
  )
  check(committed === 310, "unmount does not persist an unfinished drag")
}

async function dither() {
  const originalRequest = window.requestAnimationFrame
  const originalCancel = window.cancelAnimationFrame
  const pending = new Set<number>()
  let calls = 0
  let frames = 0
  const originalMedia = window.matchMedia
  window.requestAnimationFrame = (callback) => {
    calls++
    const id = originalRequest((time) => {
      pending.delete(id)
      frames++
      callback(time)
    })
    pending.add(id)
    return id
  }
  window.cancelAnimationFrame = (id) => {
    pending.delete(id)
    originalCancel(id)
  }
  try {
    flushSync(() =>
      root.render(
        <div className="relative h-48">
          <DitherField />
        </div>
      )
    )
    await until(() => calls > 0 && pending.size === 0)
    const settled = calls
    await new Promise((resolve) => setTimeout(resolve, 320))
    check(
      calls === settled && pending.size === 0,
      "dither has no animation frames after settling"
    )
    const canvas = fixture.querySelector("canvas")!
    check(
      canvas.width <= 480 && canvas.height <= 320,
      "dither raster dimensions stay bounded"
    )
    flushSync(() => root.render(null))
    check(pending.size === 0, "dither teardown cancels pending frames")

    window.matchMedia = (query) => {
      const media = originalMedia.call(window, query)
      if (query === "(prefers-reduced-motion: reduce)")
        Object.defineProperty(media, "matches", { value: true })
      return media
    }
    const before = frames
    flushSync(() =>
      root.render(
        <div className="relative h-48">
          <DitherField />
        </div>
      )
    )
    await until(() => frames > before && pending.size === 0)
    await new Promise((resolve) => setTimeout(resolve, 260))
    check(
      frames - before <= 2 && pending.size === 0,
      "reduced motion draws a static field without a running loop"
    )
    flushSync(() => root.render(null))
    window.matchMedia = originalMedia

    flushSync(() =>
      root.render(
        <div className="relative h-48">
          <DitherField />
        </div>
      )
    )
    await until(() => pending.size > 0)
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    })
    document.dispatchEvent(new Event("visibilitychange"))
    check(
      pending.size === 0,
      "hiding the document cancels the field immediately"
    )
    flushSync(() => root.render(null))
    Reflect.deleteProperty(document, "hidden")
  } finally {
    window.matchMedia = originalMedia
    Reflect.deleteProperty(document, "hidden")
    window.requestAnimationFrame = originalRequest
    window.cancelAnimationFrame = originalCancel
  }
}

button.onclick = async () => {
  button.disabled = true
  output.textContent = "Running production UI checks…"
  try {
    await openingDraft()
    await paragraphs()
    await transcriptAnchor()
    await clipboard()
    await divider()
    await dither()
    output.textContent += "\n\nAll UI regression checks passed."
  } catch (error) {
    output.textContent += `\nFAIL ${error instanceof Error ? error.message : String(error)}`
  } finally {
    flushSync(() => root.render(null))
    button.disabled = false
  }
}
