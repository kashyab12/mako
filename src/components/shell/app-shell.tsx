import { useCallback, useEffect, useRef, useState } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "@/components/composer/composer"
import { CommandPalette } from "@/components/palette/command-palette"
import { SettingsView } from "@/components/settings/settings-view"
import { Inspector } from "@/components/inspector/inspector"
import { SessionRail } from "@/components/rail/session-rail"
import { StatusBar } from "@/components/shell/status-bar"
import { TitleBar } from "@/components/shell/title-bar"
import { Divider } from "@/components/shell/divider"
import { Transcript } from "@/components/transcript/transcript"
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

  const railRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLDivElement>(null)

  useEffect(() => bindTheme(), [])

  useEffect(() => {
    let dispose: (() => void) | undefined
    void actions.boot().then((off) => {
      dispose = off
    })
    return () => dispose?.()
  }, [])

  // Sessions on disk change outside our process; refresh when the window
  // regains focus rather than polling.
  useEffect(() => {
    const refresh = () => {
      if (store.get().phase === "ready") void actions.refreshSessions()
    }
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  useDeskCommands()

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

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {phase === "detached" ? (
              <Blank
                icon={<PlugZapIcon />}
                title="No Pi host attached"
                body={fault ?? "Launch the desktop app so the agent runtime can connect."}
                action={
                  <Action tone="outline" size="md" className="mt-2" onClick={() => location.reload()}>
                    Retry
                  </Action>
                }
              />
            ) : (
              <>
                <Transcript />
                <Composer />
              </>
            )}
          </main>

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
            should feel like returning rather than like closing a drawer. */}
        {settingsOpen ? (
          <div className="absolute inset-0 z-40 flex flex-col bg-background">
            <SettingsView />
          </div>
        ) : null}
      </div>
      <CommandPalette />
    </TooltipProvider>
  )
}
