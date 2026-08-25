import { useCallback, useEffect, useRef, useState } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CommandPalette } from "@/components/palette/command-palette"
import { Guide } from "@/components/onboarding/guide"
import { ConversionOverlay } from "@/components/viewer/conversion-overlay"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { usePlugins } from "@/extend/use-plugins"
import { SessionRail } from "@/components/rail/session-rail"
import { TitleBar } from "@/components/shell/title-bar"
import { Divider } from "@/components/shell/divider"
import { Stage } from "@/components/stage/stage"
import { Action, Blank } from "@/components/ui/kit"
import { useDeskCommands } from "@/desk/use-desk-commands"
import { actions, store, useSession } from "@/state/session"
import { bindTheme, prefsStore, setPref, usePrefs } from "@/state/prefs"
import { PlugZapIcon } from "lucide-react"
import { WorkspaceFocusProvider } from "@/components/stage/workspace-focus"

export function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState("agents")
  const phase = useSession((state) => state.phase)
  const fault = useSession((state) => state.fault)
  const railOpen = usePrefs((prefs) => prefs.railOpen)

  const railRef = useRef<HTMLDivElement>(null)

  useEffect(() => bindTheme(), [])

  useEffect(() => {
    let active = true
    let dispose: (() => void) | undefined
    queueMicrotask(() => {
      if (!active) return
      void actions.boot().then((off) => {
        if (active) dispose = off
        else off()
      })
    })
    return () => {
      active = false
      dispose?.()
    }
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
    const open = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        Object.prototype.toString.call(event.detail) === "[object String]"
      ) {
        setSettingsSection(String(event.detail))
      }
      setSettingsOpen(true)
    }
    const close = () => setSettingsOpen(false)
    window.addEventListener("mako:settings", open)
    window.addEventListener("mako:close-settings", close)
    return () => {
      window.removeEventListener("mako:settings", open)
      window.removeEventListener("mako:close-settings", close)
    }
  }, [])

  const resizeRail = useCallback((next: number) => {
    if (railRef.current) railRef.current.style.width = `${next}px`
  }, [])

  return (
    <TooltipProvider delayDuration={350}>
      <WorkspaceFocusProvider>
        <div className="relative flex h-svh flex-col overflow-hidden bg-shell text-foreground">
        <TitleBar />
        <div className="relative z-10 flex min-h-0 flex-1">
          {railOpen ? (
            <>
              <div
                ref={railRef}
                style={{ width: prefsStore.get().railWidth }}
                className="flex min-h-0 shrink-0 flex-col overflow-hidden"
              >
                <SessionRail />
              </div>
              <Divider
                side="left"
                size={prefsStore.get().railWidth}
                min={200}
                max={420}
                onResize={resizeRail}
                onCommit={(next) => setPref("railWidth", next)}
              />
            </>
          ) : null}

          {phase === "detached" ? (
            <main className="card relative m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
            </main>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <Stage />
            </div>
          )}
        </div>
      </div>
      <CommandPalette />
      {/* Settings floats as a large centered dialog under the palette's z-50:
          the desk stays visible behind the scrim, and Radix owns Escape, the
          scrim, and the focus trap. */}
      <SettingsDialog
        open={settingsOpen}
        section={settingsSection}
        onOpenChange={(open) => {
          if (!open) setSettingsOpen(false)
        }}
        onSectionChange={setSettingsSection}
      />
        <Guide />
        <ConversionOverlay />
      </WorkspaceFocusProvider>
    </TooltipProvider>
  )
}
