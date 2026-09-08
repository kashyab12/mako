// Explicit deterministic fixture page. Normal verification still uses the real host.
import { useState, useSyncExternalStore } from "react"
import type { ThreadEntry } from "@mako/sessions"
import { Prose } from "@/components/transcript/markdown"
import { TranscriptAttachment } from "@/components/transcript/attachment"
import { TranscriptSourceContext } from "@/components/transcript/source-context"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threadToMessages } from "@/lib/foreign-thread"
import { toExchanges } from "@/lib/exchanges"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()
let reads = 0
const listeners = new Set<() => void>()
const source = { threadPath: "/fixture/native-thread" }
const imageUrl = new URL("/icons/app-icon.png", location.href).href
window.mako!.readThreadFile = async (_threadPath, path) => {
  reads += 1
  listeners.forEach((listener) => listener())
  if (path.includes("missing")) throw new Error("File no longer exists")
  return {
    path,
    contents: "",
    binary: true,
    truncated: false,
    size: 512,
    media: "image",
    mimeType: "image/png",
    previewUrl: imageUrl,
  }
}
window.mako!.resolveFileUrl = (url) => url
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const entries: ThreadEntry[] = [
  { kind: "user", text: "Read the retained image and update the file" },
  {
    kind: "assistant",
    blocks: [
      {
        type: "tool",
        id: "read",
        name: "Read",
        input: '{"path":"/fixture/proof.png"}',
        output: "",
        attachments: [
          {
            type: "attachment",
            name: "Returned image",
            mimeType: "image/png",
            source: { kind: "url", url: imageUrl },
          },
        ],
      },
      {
        type: "tool",
        id: "edit",
        name: "Edit",
        output: "",
        details: [
          {
            type: "diff",
            path: "/fixture/app.ts",
            oldText: "const answer = 1\n",
            newText: "const answer = 2\n",
          },
          { type: "terminal", terminalId: "terminal-7" },
        ],
      },
      {
        type: "tool",
        id: "plan",
        name: "Plan",
        output: "",
        details: [
          {
            type: "plan",
            entries: [
              { content: "Read the **image**", status: "completed" },
              { content: "Update `src/app.ts`", status: "completed" },
            ],
          },
        ],
      },
      {
        type: "thinking",
        text: "**Checking evidence**\n\n- Retain image ownership\n- Inspect `src/app.ts:12-18`",
      },
      {
        type: "text",
        text: "Done. The returned image belongs inside its Read result.",
      },
    ],
  },
]
const exchanges = toExchanges(threadToMessages(entries, 0, "claude"))
const code =
  "```typescript\nconst answer: number = 42\n\nconsole.log(answer)\n```\n\n```mermaid\nflowchart LR\n  Prompt --> Agent\n  Agent --> Tool\n  Tool --> Answer\n```"
const table =
  "| File | Confidence | Result |\n| --- | --- | --- |\n| `src/app.ts:12` | Confirmed | A complete readable result without splitting the header |\n| `package.json` | Confirmed | 3 checks passed |"
export function Fixtures() {
  const [mode, setMode] = useState<
    "Media" | "Code and diagrams" | "Tool results" | "Tables"
  >("Media")
  const count = useSyncExternalStore(subscribe, () => reads)
  return (
    <TooltipProvider>
      <div className="h-screen overflow-auto bg-surface text-foreground">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-hairline bg-shell p-4">
          <h1 className="text-title font-semibold">Transcript fixtures</h1>
          {(
            ["Media", "Code and diagrams", "Tool results", "Tables"] as const
          ).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              className="pressable rounded border border-hairline px-2 py-1 text-ui"
              onClick={() => setMode(value)}
            >
              {value}
            </button>
          ))}
          <span className="text-label text-faint">{count} file reads</span>
        </header>
        <main className="mx-auto max-w-content p-6">
          <TranscriptSourceContext value={source}>
            {mode === "Media" ? (
              <div className="space-y-6">
                <Prose text="Local Markdown image: ![Local proof](/fixture/proof.png)" />
                <TranscriptAttachment
                  attachment={{
                    type: "attachment",
                    name: "URL image",
                    mimeType: "image/png",
                    source: { kind: "url", url: imageUrl },
                  }}
                />
                <Prose
                  text={
                    "![Missing image](/fixture/missing.png)\n\n![Audio proof](https://example.invalid/proof.mp3)\n\n![Video proof](https://example.invalid/proof.mp4)"
                  }
                />
                <div className="pt-[2000px]">
                  <TranscriptAttachment
                    attachment={{
                      type: "attachment",
                      name: "Offscreen proof",
                      mimeType: "image/png",
                      source: { kind: "file", path: "/fixture/offscreen.png" },
                    }}
                  />
                </div>
              </div>
            ) : mode === "Code and diagrams" ? (
              <Prose text={code} />
            ) : mode === "Tables" ? (
              <Prose text={table} />
            ) : (
              <ConversationTimeline
                identity="transcript-fixture"
                source={source}
                exchanges={exchanges}
                empty={null}
              />
            )}
          </TranscriptSourceContext>
        </main>
      </div>
    </TooltipProvider>
  )
}
