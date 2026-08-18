import { useCallback, useEffect, useRef, useState } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "@/components/composer/composer"
import { CommandPalette } from "@/components/palette/command-palette"
import { Guide } from "@/components/onboarding/guide"
import { ThreadViewer } from "@/components/viewer/thread-viewer"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { SettingsView } from "@/components/settings/settings-view"
import { usePlugins } from "@/extend/use-plugins"
import { Inspector } from "@/components/inspector/inspector"
import { SessionRail } from "@/components/rail/session-rail"
import { StatusBar } from "@/components/shell/status-bar"
import { TitleBar } from "@/components/shell/title-bar"
import { TabStrip } from "@/components/shell/tab-strip"
import { Divider } from "@/components/shell/divider"
import { Transcript } from "@/components/transcript/transcript"
import { FileViewer } from "@/components/viewer/file-viewer"
import { SearchView } from "@/components/search/search-view"
import { PreviewPane } from "@/components/preview/preview-pane"
import { Action, Blank } from "@/components/ui/kit"
import { useDeskCommands } from "@/desk/use-desk-commands"
import { actions, store, useSession } from "@/state/session"
import { bindTheme, prefsStore, setPref, usePrefs } from "@/state/prefs"
import { PlugZapIcon } from "lucide-react"

export function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const phase = useSession((state) => state.phase)
  const fault = useSession((state) => state.fault)
  const railOpen = usePrefs((prefs) => prefs.railOpen)
  const inspectorOpen = usePrefs((prefs) => prefs.inspectorOpen)
  const previewOpen = usePrefs((prefs) => prefs.previewOpen)

  const railRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => bindTheme(), [])

  useEffect(() => {
    let dispose: (() => void) | undefined
    void actions.boot().then((off) => {
      dispose = off
    })
    return () => dispose?.()
  }, [])

  // Sessions and the working tree both change outside our process — a branch
  // switched in a terminal, a session started elsewhere. Refresh when the
  // window regains focus rather than polling for either.
  useEffect(() => {
    const refresh = () => {
      if (store.get().phase !== "ready") return
      void actions.refreshSessions()
      void actions.refreshGit()
    }
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  useDeskCommands()
  usePlugins()

  useEffect(() => {
    const open = () => setSettingsOpen(true)
    const close = () => setSettingsOpen(false)
    window.addEventListener("pi:settings", open)
    window.addEventListener("pi:close-settings", close)
    return () => {
      window.removeEventListener("pi:settings", open)
      window.removeEventListener("pi:close-settings", close)
    }
  }, [])

  const resizeRail = useCallback((next: number) => {
    if (railRef.current) railRef.current.style.width = `${next}px`
  }, [])
  const resizeInspector = useCallback((next: number) => {
    if (inspectorRef.current) inspectorRef.current.style.width = `${next}px`
  }, [])
  const resizePreview = useCallback((next: number) => {
    if (previewRef.current) previewRef.current.style.width = `${next}px`
  }, [])

  return (
    <TooltipProvider delayDuration={350}>
      <div className="app-wash relative flex h-svh flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <div className="relative z-10 flex min-h-0 flex-1">
          {railOpen ? (
            <>
              <div
                ref={railRef}
                style={{ width: prefsStore.get().railWidth }}
                className="panel-glass flex min-h-0 shrink-0 flex-col overflow-hidden bg-surface"
              >
                <SessionRail />
              </div>
              <Divider
                side="left"
                width={prefsStore.get().railWidth}
                min={200}
                max={420}
                onResize={resizeRail}
                onCommit={(next) => setPref("railWidth", next)}
              />
            </>
          ) : null}

          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {phase === "detached" ? (
              <Blank
                icon={<PlugZapIcon />}
                title="No agent attached"
                body={fault ?? "Launch the desktop app so the agent runtime can connect."}
                action={
                  <Action tone="outline" size="md" className="mt-2" onClick={() => location.reload()}>
                    Retry
                  </Action>
                }
              />
            ) : (
              <>
                <TabStrip />
                <Transcript />
                <Composer />
                {/* Over the conversation column only. The rail stays reachable,
                    so you can walk the tree with a file already open. */}
                <FileViewer />
                <SearchView />
              </>
            )}
          </main>

          {/* The preview is a sibling of the conversation, not an overlay on
              it: the whole point is watching the thing change while you talk
              about it. */}
          {previewOpen && phase !== "detached" ? (
            <>
              <Divider
                side="right"
                width={prefsStore.get().previewWidth}
                min={320}
                max={900}
                onResize={resizePreview}
                onCommit={(next) => setPref("previewWidth", next)}
              />
              <div
                ref={previewRef}
                style={{ width: prefsStore.get().previewWidth }}
                className="flex min-h-0 shrink-0 flex-col overflow-hidden"
              >
                <PreviewPane />
              </div>
            </>
          ) : null}

          {inspectorOpen ? (
            <>
              <Divider
                side="right"
                width={prefsStore.get().inspectorWidth}
                min={300}
                max={720}
                onResize={resizeInspector}
                onCommit={(next) => setPref("inspectorWidth", next)}
              />
              <div
                ref={inspectorRef}
                style={{ width: prefsStore.get().inspectorWidth }}
                className="panel-glass flex min-h-0 shrink-0 flex-col overflow-hidden bg-surface"
              >
                <Inspector />
              </div>
            </>
          ) : null}
        </div>
        <StatusBar />

        {/* Settings covers the whole window rather than only the chat column:
            it is a place you go, not a panel you consult, and leaving it
            should feel like returning rather than like closing a drawer.

            Below the title bar, though, not over it. The window controls are
            drawn by the OS on top of whatever we paint, so covering that strip
            put the traffic lights on top of the first section in the list. */}
        {settingsOpen ? (
          <div
            className="absolute inset-x-0 bottom-0 z-40 flex flex-col bg-background"
            style={{ top: "var(--titlebar-height)" }}
          >
            <SettingsView />
          </div>
        ) : null}
      </div>
      <CommandPalette />
      <Guide />
      <ThreadViewer />
      <AcpPanel />
    </TooltipProvider>
  )
}
