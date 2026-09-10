import { Profiler, useState, type ProfilerOnRenderCallback } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { AcpPanel } from "../src/components/viewer/acp-panel"
import { AgentThreads } from "../src/components/rail/agent-threads"
import { ContextPanel } from "../src/components/inspector/context-panel"
import { Composer } from "../src/components/composer/composer"
import { Prose } from "../src/components/transcript/markdown"
import { WorkspaceFocusContext } from "../src/components/stage/workspace-focus-context"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { installMockBridge } from "../src/dev/mock-bridge"
import { acpStore } from "../src/state/acp-state"
import { applyLiveBatch, applyLiveSnapshot } from "../src/state/live-recovery"
import { threadsStore } from "../src/state/thread-store"
import { store } from "../src/state/session"
import {
  auditId,
  auditSnapshot,
  auditStats,
} from "./performance-audit-fixtures"
import "../src/index.css"

const fixture = installMockBridge()
let turns = 10
let epoch = 0
let updateView: (
  mode: "thread" | "markdown",
  side: boolean,
  text: string
) => void = () => {}
const commits = new Map<string, number[]>()
const onRender: ProfilerOnRenderCallback = (id, _phase, duration) => {
  const values = commits.get(id) ?? []
  values.push(duration)
  commits.set(id, values)
}
const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const metrics = () => ({
  commits: Object.fromEntries(
    [...commits].map(([key, values]) => [
      key,
      { ...auditStats(values), totalMs: values.reduce((a, b) => a + b, 0) },
    ])
  ),
  parses: {
    calls: globalThis.performanceAuditParses?.length ?? 0,
    uniqueLengths: new Set(
      globalThis.performanceAuditParses?.map((entry) => entry.chars)
    ).size,
    ...auditStats(
      globalThis.performanceAuditParses?.map((entry) => entry.elapsedMs) ?? []
    ),
  },
  mountedTurns: document.querySelectorAll("[data-exchange]").length,
  navigatorButtons: document.querySelectorAll(
    'nav[aria-label="Previous prompts"] button'
  ).length,
  domNodes: document.querySelectorAll("*").length,
})
function reset() {
  commits.clear()
  globalThis.performanceAuditParses = []
}

async function setup(count: number, side = false) {
  turns = count
  epoch++
  const snapshot = auditSnapshot(turns, "claude", 512, 256)
  fixture.setLiveSnapshot(snapshot)
  flushSync(() => {
    acpStore.set({ activeKey: snapshot.session.id, conversations: {} })
    threadsStore.set({
      threads: [],
      viewing: null,
      opening: null,
      loaded: true,
      composerHarness: "claude",
    })
    store.set({ messages: [], stream: null })
    applyLiveSnapshot(snapshot)
    updateView("thread", side, "")
  })
  await document.fonts.ready
  await frames()
  reset()
  return metrics()
}

async function stream(count = 40, side = false, inactive = false) {
  if (inactive) {
    const other = auditSnapshot(1, "claude", 128, 0)
    other.session = { ...other.session, id: auditId(999999), status: "ready" }
    fixture.setLiveSnapshot(other)
    applyLiveSnapshot(other)
    acpStore.set({ activeKey: other.session.id })
    await frames()
  }
  reset()
  const apply: number[] = [],
    gaps: number[] = []
  let running = true,
    previousFrame = performance.now()
  const track = (now: number) => {
    gaps.push(now - previousFrame)
    previousFrame = now
    if (running) requestAnimationFrame(track)
  }
  requestAnimationFrame(track)
  for (let frame = 0; frame < count; frame++) {
    const before = performance.now()
    applyLiveBatch({
      id: auditId(0),
      revision: (acpStore.get().conversations[auditId(0)]?.revision ?? 0) + 1,
      updates: [{ kind: "text", id: `text-${turns - 1}`, text: " next delta" }],
    })
    apply.push(performance.now() - before)
    await pause(20)
  }
  await frames()
  running = false
  return {
    turns,
    side,
    inactive,
    apply: auditStats(apply),
    frameGaps: auditStats(gaps),
    ...metrics(),
  }
}

async function markdown(chars: number) {
  let text =
    "## Styled content\n\n" +
    "This paragraph keeps **emphasis**, [a link](https://example.test), and readable rhythm.\n\n"
      .repeat(Math.ceil(chars / 86))
      .slice(0, chars)
  flushSync(() => updateView("markdown", false, text))
  await pause(120)
  await frames()
  reset()
  for (let frame = 0; frame < 30; frame++) {
    text += " next word"
    flushSync(() => updateView("markdown", false, text))
    await pause(10)
  }
  await pause(120)
  await frames()
  const deadline = performance.now() + 10000
  while (
    document.querySelector<HTMLElement>(".mako-prose")?.dataset
      .renderedChars !== String(text.length)
  ) {
    if (performance.now() >= deadline)
      throw new Error("The latest Markdown source was not displayed")
    await pause(10)
  }
  const usedWorker =
    document.querySelector(".mako-prose")?.hasAttribute("data-prose-worker") ??
    false
  const html = document.querySelector(".mako-prose")?.innerHTML ?? ""
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(html)
  )
  const htmlHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return { chars, updates: 30, htmlHash, usedWorker, ...metrics() }
}

async function setupEarlier() {
  await setup(300)
  const snapshot: ReturnType<typeof auditSnapshot> = {
    ...auditSnapshot(300),
    revision: 2,
    base: {
      ref: {
        harness: "claude",
        nativeId: "base",
        path: "/performance-fixture/native",
      },
      entries: [],
      start: 2,
      total: 2,
      hasEarlier: true,
    },
  }
  flushSync(() => applyLiveSnapshot(snapshot))
  fixture.setLiveSnapshot({
    ...snapshot,
    revision: 3,
    base: {
      ref: {
        harness: "claude",
        nativeId: "base",
        path: "/performance-fixture/native",
      },
      entries: [
        { kind: "user", id: "older", text: "Earlier native question" },
        {
          kind: "assistant",
          blocks: [{ type: "text", text: "Earlier native answer" }],
        },
      ],
      start: 0,
      total: 2,
      hasEarlier: false,
    },
  })
  await frames()
  return metrics()
}

interface AuditApi {
  setupEarlier: typeof setupEarlier
  setup: typeof setup
  stream: typeof stream
  markdown: typeof markdown
  metrics: typeof metrics
  result: Awaited<ReturnType<typeof stream>> | null
  done: boolean
}
const api: AuditApi = {
  setupEarlier,
  setup,
  stream,
  markdown,
  metrics,
  result: null,
  done: false,
}
declare global {
  interface Window {
    performanceAudit: AuditApi
  }
}
window.performanceAudit = api
function AuditView() {
  const [view, setView] = useState<{
    mode: "thread" | "markdown"
    side: boolean
    text: string
  }>({ mode: "thread", side: false, text: "" })
  updateView = (mode, side, text) => setView({ mode, side, text })
  return (
    <TooltipProvider>
      <WorkspaceFocusContext
        value={{
          identity: "performance",
          cwd: "/performance-fixture",
          title: "Performance fixture",
          ready: true,
        }}
      >
        <div className="flex h-screen bg-surface">
          {view.mode === "thread" ? (
            <>
              <aside className="w-64 shrink-0 border-r border-hairline">
                <Profiler id="rail" onRender={onRender}>
                  <AgentThreads />
                </Profiler>
              </aside>
              <main key={epoch} className="flex min-w-0 flex-1 flex-col">
                <Profiler id="timeline" onRender={onRender}>
                  <AcpPanel />
                </Profiler>
                <Profiler id="composer" onRender={onRender}>
                  <Composer />
                </Profiler>
              </main>
              {view.side ? (
                <aside className="w-80 shrink-0 border-l border-hairline">
                  <Profiler id="context" onRender={onRender}>
                    <ContextPanel />
                  </Profiler>
                </aside>
              ) : null}
            </>
          ) : (
            <main className="h-screen w-full overflow-auto p-6">
              <Profiler id="markdown" onRender={onRender}>
                <Prose text={view.text} streaming />
              </Profiler>
            </main>
          )}
        </div>
      </WorkspaceFocusContext>
    </TooltipProvider>
  )
}
const root = document.getElementById("root")
if (!root) throw new Error("Audit root missing")
flushSync(() => createRoot(root).render(<AuditView />))
await setup(10)
