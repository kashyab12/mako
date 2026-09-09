import {
  preserveSendingDraft,
  interruptSendingDraft,
} from "@/state/send-recovery"
// Explicit isolated fixture; never imported by the application entry point.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Composer } from "@/components/composer/composer"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { AgentsPanel } from "@/components/inspector/agents-panel"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp"
import { threadsStore } from "@/state/thread-store"
import { store } from "@/state/session"
import type { LiveSnapshot } from "@/lib/types"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

const mock = installMockBridge()
const id = "11111111-1111-4111-8111-111111111111"
const requestId = "22222222-2222-4222-8222-222222222222"
const cwd = "/fixture/project"
const snapshot: LiveSnapshot = {
  session: {
    id,
    harness: "claude",
    nativeId: "fixture-parent",
    cwd,
    title: "Review the routing changes",
    connection: "connected",
    status: "ready",
    modes: [
      { id: "default", name: "Ask for approval" },
      { id: "plan", name: "Plan" },
    ],
    currentMode: "default",
    configOptions: [],
  },
  revision: 1,
  createdAt: 1,
  base: null,
  permissions: [],
  requests: [
    {
      id: requestId,
      text: "Review the routing changes and check the tests.",
      attachments: [],
      status: "completed",
    },
  ],
  blocks: [
    {
      type: "user",
      text: "Review the routing changes and check the tests.",
      requestId,
    },
    {
      type: "text",
      text: "The route handling is consistent. One missing case needs attention: an expired session should return to sign-in while preserving the requested destination.",
    },
  ],
  control: {
    activeBindingId: id,
    bindings: [],
    children: [],
    merges: [],
    transfers: [],
    actions: [],
  },
  nativeAgents: {
    limited: false,
    agents: [
      {
        bindingId: id,
        provider: "claude",
        nativeId: "working",
        title: "Check route recovery and session expiry",
        role: "Explore",
        state: {
          kind: "working",
          activity: "Reading the session guard and redirect tests",
        },
        observedAt: 1,
        usage: { tokens: 2450, toolUses: 6, durationMs: 23000 },
      },
      {
        bindingId: id,
        provider: "claude",
        nativeId: "done",
        title: "Review test coverage",
        state: {
          kind: "completed",
          summary:
            "The success and signed-out paths have coverage.\n\nThe expired-session path does not. Add a regression test that expires the session, opens a protected deep link, and verifies that signing in returns to the same destination.\n\nNo files were changed.",
        },
        observedAt: 1,
        usage: { tokens: 6210, toolUses: 11, durationMs: 54000 },
      },
      {
        bindingId: id,
        provider: "claude",
        nativeId: "failed",
        title: "Check browser behavior",
        state: {
          kind: "failed",
          error:
            "Browser connection ended before the redirect could be checked.",
        },
        observedAt: 1,
      },
    ],
  },
}
threadsStore.set({
  composerHarness: "claude",
  acpable: ["claude", "codex"],
  liveCapabilities: [
    {
      provider: "claude",
      canResume: true,
      canSteer: true,
      canCompact: true,
      observesNativeAgents: true,
    },
  ],
})
store.set({ messages: [], stream: null })
acpStore.set({ activeKey: id })
snapshot.blocks.push({
  type: "proposed-plan",
  id: "routing-plan",
  text: "# Route recovery\n\nPreserve the destination when an expired session sends the user to sign-in.\n\n## Implementation\n\n1. Keep the original URL while refreshing the session.\n2. Restore that URL after successful sign-in.\n3. Use the existing safe redirect validation.\n\n## Verification\n\nCover a protected deep link, an expired session, and an external redirect attempt.",
  status: "proposed",
})
mock.setLiveSnapshot(snapshot)
applyLiveSnapshot(snapshot)
function publishQueue(starting: boolean) {
  const next: LiveSnapshot = {
    ...snapshot,
    revision: (acpStore.get().conversations[id]?.revision ?? 0) + 1,
    session: {
      ...snapshot.session,
      status: starting ? "starting" : "running",
      connection: starting ? "starting" : "connected",
    },
    blocks: starting ? [] : snapshot.blocks,
    requests: [
      {
        ...snapshot.requests[0]!,
        text: "Review the routing changes and check the tests.",
        status: starting ? "queued" : "dispatching",
      },
      ...(starting
        ? []
        : [
            {
              id: "33333333-3333-4333-8333-333333333333",
              text: "Also check keyboard navigation and focus after signing in.",
              attachments: [],
              status: "queued" as const,
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              text: "Keep the existing deep link when the session expires. Include a regression test.",
              attachments: [],
              status: "queued" as const,
            },
            {
              id: "55555555-5555-4555-8555-555555555555",
              text: "Give me a short summary of what changed.",
              attachments: [],
              status: "queued" as const,
            },
          ]),
    ],
  }
  mock.setLiveSnapshot(next)
  applyLiveSnapshot(next)
}
export function Fixture() {
  const [narrow, setNarrow] = useState(false)
  return (
    <TooltipProvider>
      <WorkspaceFocusContext
        value={{
          identity: `live:${id}`,
          cwd,
          title: snapshot.session.title,
          ready: true,
        }}
      >
        <div className="flex h-screen flex-col bg-surface">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-4 py-2 text-label text-faint">
            <span>Isolated live workflow fixture · no agent is started</span>
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              onClick={() => publishQueue(true)}
            >
              First message startup
            </button>
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              onClick={() => {
                const receipt = preserveSendingDraft({
                  key: id,
                  text: "Recover the interrupted paragraph without replacing my new draft.",
                  attachments: [],
                })
                if (receipt) interruptSendingDraft(receipt)
              }}
            >
              Interrupted send
            </button>
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              onClick={() => publishQueue(false)}
            >
              Working with queue
            </button>
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              onClick={() => setNarrow((value) => !value)}
            >
              {narrow ? "Wide layout" : "Narrow layout"}
            </button>
          </div>
          <div
            className={`mx-auto flex min-h-0 w-full flex-1 ${narrow ? "max-w-[760px]" : "max-w-[1280px]"}`}
          >
            <main className="flex min-w-0 flex-1 flex-col">
              <AcpPanel />
              <Composer />
            </main>
            <aside
              className={`min-h-0 shrink-0 border-l border-hairline ${narrow ? "w-80" : "w-96"}`}
              aria-label="Agents companion"
            >
              <AgentsPanel />
            </aside>
          </div>
        </div>
        <Toaster />
      </WorkspaceFocusContext>
    </TooltipProvider>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
