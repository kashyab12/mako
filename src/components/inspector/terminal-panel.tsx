import { useCallback, useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { PlusIcon, RefreshCwIcon, TerminalSquareIcon, XIcon } from "lucide-react"
import { Blank } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { createHook } from "@/state/store"
import {
  replayTerminalOutput,
  subscribeTerminalOutput,
  terminalActions,
  terminalStore,
  type TerminalOutput,
} from "@/state/terminal"
import type { TerminalSession } from "@/lib/types"

const useTerminal = createHook(terminalStore)

export function TerminalPanel() {
  const cwd = useSession((state) => state.meta?.cwd)
  const phase = useTerminal((state) => state.phase)
  const sessions = useTerminal((state) => state.sessions)
  const activeId = useTerminal((state) => state.activeId)
  const fault = useTerminal((state) => state.fault)
  const active = sessions.find((session) => session.id === activeId)

  useEffect(() => terminalActions.mount(), [])

  if (phase === "connecting" && sessions.length === 0) {
    return (
      <Blank
        icon={<TerminalSquareIcon />}
        title="Connecting to terminals"
        body="The local terminal service is starting. Existing shells will reattach automatically."
      />
    )
  }

  if (phase === "error" && sessions.length === 0) {
    return (
      <Blank
        icon={<TerminalSquareIcon />}
        title="Terminal unavailable"
        body={fault ?? "The local terminal service disconnected."}
        action={<Action label="Retry" onClick={() => void terminalActions.refresh()} />}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center border-b border-hairline">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex h-9 min-w-max items-center px-1">
            {sessions.map((session) => (
              <SessionTab
                key={session.id}
                session={session}
                active={session.id === activeId}
                onSelect={() => terminalActions.activate(session.id)}
                onClose={() => void terminalActions.kill(session.id)}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          title="New terminal"
          disabled={!cwd}
          onClick={() => cwd && void terminalActions.create(cwd)}
          className="pressable mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      {active ? (
        <TerminalViewport key={active.id} session={active} />
      ) : (
        <Blank
          icon={<TerminalSquareIcon />}
          title="No terminals"
          body="Start a shell in the current workspace. It will keep running if this window closes."
          action={
            cwd ? (
              <Action label="New terminal" onClick={() => void terminalActions.create(cwd)} />
            ) : undefined
          }
        />
      )}

      {fault && active ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-negative/30 bg-negative/10 px-2.5 py-1.5 text-[11px] text-negative">
          <span className="min-w-0 flex-1 truncate">{fault}</span>
          <button
            type="button"
            onClick={() => void terminalActions.refresh()}
            className="pressable flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-negative/10"
          >
            <RefreshCwIcon className="size-3" />
            Reconnect
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SessionTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSession
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <div
      className={cn(
        "group flex h-7 max-w-44 items-center rounded-md text-[11px]",
        active ? "bg-fill-selected text-foreground" : "text-faint hover:text-muted-foreground"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            session.status === "running"
              ? "bg-positive"
              : session.status === "interrupted"
                ? "bg-caution"
                : "bg-faint"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{session.title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${session.title}`}
        onClick={onClose}
        className="pressable mr-1 flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-background/40 group-hover:opacity-100 focus:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

function TerminalViewport({ session }: { session: TerminalSession }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resizeFrame = useRef<number | undefined>(undefined)
  const writtenSequence = useRef(0)
  const snapshot = useTerminal((state) =>
    state.activeId === session.id ? state.snapshot : undefined
  )
  const theme = usePrefs((prefs) => prefs.theme)

  const fit = useCallback(() => {
    const terminal = terminalRef.current
    const addon = fitRef.current
    if (!terminal || !addon || !hostRef.current?.isConnected) return
    addon.fit()
    terminalActions.resize(terminal.cols, terminal.rows)
  }, [])

  const writeOutput = useCallback(
    (output: TerminalOutput) => {
      if (output.sessionId !== session.id) return
      if (output.sequence <= writtenSequence.current) return
      if (output.sequence !== writtenSequence.current + 1) {
        terminalActions.resync()
        return
      }
      terminalRef.current?.write(output.data)
      writtenSequence.current = output.sequence
    },
    [session.id]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const style = getComputedStyle(host)
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: style.getPropertyValue("--font-mono"),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5_000,
      allowTransparency: true,
      theme: terminalTheme(style),
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = addon
    const input = terminal.onData((data) => terminalActions.write(data))
    const observer = new ResizeObserver(() => {
      if (resizeFrame.current !== undefined) cancelAnimationFrame(resizeFrame.current)
      resizeFrame.current = requestAnimationFrame(fit)
    })
    observer.observe(host)
    fit()
    terminal.focus()
    return () => {
      observer.disconnect()
      if (resizeFrame.current !== undefined) cancelAnimationFrame(resizeFrame.current)
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [fit])

  useEffect(() => {
    const host = hostRef.current
    const terminal = terminalRef.current
    if (!host || !terminal) return
    terminal.options.theme = terminalTheme(getComputedStyle(host))
  }, [theme])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !snapshot) return
    terminal.reset()
    terminal.write(snapshot.data)
    writtenSequence.current = snapshot.sequence
    replayTerminalOutput(writeOutput)
  }, [snapshot, writeOutput])

  useEffect(
    () => subscribeTerminalOutput(writeOutput),
    [writeOutput]
  )

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={hostRef} className="h-full bg-surface p-2 font-mono" />
      {session.status !== "running" ? (
        <div className="absolute inset-x-2 bottom-2 flex items-center justify-between rounded-md border border-hairline bg-raised px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <span>
            {session.status === "interrupted"
              ? "Shell interrupted · saved scrollback restored"
              : `Shell exited${session.exitCode === undefined ? "" : ` with code ${session.exitCode}`}`}
          </span>
          <button
            type="button"
            onClick={() => void terminalActions.create(session.cwd, session.cols, session.rows)}
            className="pressable rounded px-1.5 py-0.5 text-foreground hover:bg-background/30"
          >
            New shell
          </button>
        </div>
      ) : null}
    </div>
  )
}

function terminalTheme(style: CSSStyleDeclaration) {
  return {
    background: style.getPropertyValue("--surface"),
    foreground: style.getPropertyValue("--foreground"),
    cursor: style.getPropertyValue("--foreground"),
    cursorAccent: style.getPropertyValue("--surface"),
    selectionBackground: style.getPropertyValue("--fill-selected"),
    black: style.getPropertyValue("--background"),
    brightBlack: style.getPropertyValue("--faint"),
    white: style.getPropertyValue("--muted-foreground"),
    brightWhite: style.getPropertyValue("--foreground"),
    red: style.getPropertyValue("--negative"),
    brightRed: style.getPropertyValue("--removed"),
    green: style.getPropertyValue("--positive"),
    brightGreen: style.getPropertyValue("--added"),
    yellow: style.getPropertyValue("--caution"),
    brightYellow: style.getPropertyValue("--caution"),
    blue: style.getPropertyValue("--muted-foreground"),
    brightBlue: style.getPropertyValue("--foreground"),
    cyan: style.getPropertyValue("--muted-foreground"),
    brightCyan: style.getPropertyValue("--foreground"),
    magenta: style.getPropertyValue("--muted-foreground"),
    brightMagenta: style.getPropertyValue("--foreground"),
  }
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable mt-1 rounded-md bg-raised px-2.5 py-1.5 text-[11.5px] font-medium text-foreground hover:bg-foreground/15"
    >
      {label}
    </button>
  )
}
