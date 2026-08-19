import { useEffect, useMemo, useRef, useState } from "react"
import { Action, IconAction } from "@/components/ui/kit"
import { dev, useDev } from "@/state/devserver"
import { getMako } from "@/lib/bridge"
import { stage } from "@/state/stage"
import { cn } from "@/lib/utils"
import {
  ExternalLinkIcon,
  MonitorIcon,
  RotateCwIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"

/**
 * The thing being built, beside the conversation about it.
 *
 * A `<webview>` rather than an iframe: the previewed app gets its own process
 * and its own storage, so it cannot reach this window and its cookies never
 * mix with the app's. It also means a page that crashes takes itself down and
 * not the editor.
 *
 * The pane never starts anything on its own. Running an arbitrary npm script
 * because someone opened a panel is not a thing an editor should do quietly.
 */
export function PreviewPane() {
  const status = useDev((state) => state.status)
  const url = useDev((state) => state.url)

  useEffect(() => {
    void dev.load()
  }, [])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <Toolbar />
      <div className="relative min-h-0 flex-1">
        {status === "running" && url ? (
          <Frame url={url} />
        ) : status === "starting" ? (
          <Waiting />
        ) : (
          <Setup />
        )}
      </div>
      <Logs />
    </div>
  )
}

function Toolbar() {
  const status = useDev((state) => state.status)
  const url = useDev((state) => state.url)
  const running = status === "running" || status === "starting"

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-hairline px-2">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "running"
            ? "bg-added"
            : status === "starting"
              ? "animate-live bg-caution"
              : status === "failed"
                ? "bg-removed"
                : "bg-foreground/25"
        )}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-label text-faint">
        {url ?? (status === "starting" ? "starting…" : "not running")}
      </span>

      {url ? (
        <>
          <IconAction label="Reload" size="xs" onClick={() => dev.reload()}>
            <RotateCwIcon />
          </IconAction>
          <IconAction
            label="Open in your browser"
            size="xs"
            onClick={() => void getMako().openUrl(url)}
          >
            <ExternalLinkIcon />
          </IconAction>
        </>
      ) : null}
      {running ? (
        <IconAction label="Stop the server" size="xs" tone="danger" onClick={() => void dev.stop()}>
          <SquareIcon />
        </IconAction>
      ) : null}
      <IconAction
        label="Close the preview"
        size="xs"
        onClick={() => stage.close()}
      >
        <XIcon />
      </IconAction>
    </div>
  )
}

/**
 * The preview itself.
 *
 * `key` carries the reload counter so asking for a reload remounts the view.
 * Calling `reload()` on the element would be lighter, but a dev server that has
 * just restarted often needs the connection re-established rather than the
 * page re-fetched, and a remount does both.
 */
function Frame({ url }: { url: string }) {
  const reloads = useDev((state) => state.reloads)
  const host = useRef<HTMLDivElement>(null)

  // `<webview>` is not a React element, so it is created by hand. Recreating
  // it on url or reload change is the whole lifecycle.
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const view = document.createElement("webview")
    view.setAttribute("src", url)
    view.setAttribute("partition", "persist:preview")
    view.setAttribute("allowpopups", "false")
    view.style.width = "100%"
    view.style.height = "100%"
    view.style.display = "flex"
    parent.replaceChildren(view)
    return () => parent.replaceChildren()
  }, [reloads, url])

  return <div ref={host} className="absolute inset-0" />
}

function Waiting() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <MonitorIcon className="size-5 text-faint" />
      <p className="shimmer text-ui">Waiting for the server to say where it is listening…</p>
    </div>
  )
}

/**
 * What to run.
 *
 * Lists the project's own scripts rather than guessing one, and offers to
 * point at something already running, because plenty of people keep a server
 * up in a terminal and only want to see it here.
 */
function Setup() {
  const scripts = useDev((state) => state.scripts)
  const status = useDev((state) => state.status)
  const exitCode = useDev((state) => state.exitCode)
  const [url, setUrl] = useState("http://localhost:3000")

  const suggestion = useMemo(() => scripts[0], [scripts])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <MonitorIcon className="size-5 text-faint" />
      <div className="max-w-[22rem]">
        <p className="text-ui font-medium">
          {status === "failed" ? "The server stopped" : "Nothing is being served yet"}
        </p>
        <p className="mt-1 text-ui leading-relaxed text-muted-foreground">
          {status === "failed"
            ? `It exited${exitCode == null ? "" : ` with code ${exitCode}`}. The output is below.`
            : "Run one of this project's scripts, or point the pane at a server you already have running."}
        </p>
      </div>

      {scripts.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {scripts.slice(0, 5).map((script) => (
            <Action
              key={script}
              tone={script === suggestion ? "outline" : "ghost"}
              onClick={() => void dev.start(script)}
            >
              npm run {script}
            </Action>
          ))}
        </div>
      ) : null}

      <Ports />

      <div className="flex w-full max-w-[22rem] items-center gap-1.5">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && url.trim()) void dev.attach(url.trim())
          }}
          placeholder="http://localhost:3000"
          className="h-7 min-w-0 flex-1 rounded-md bg-raised px-2 text-ui placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
        />
        <Action tone="ghost" disabled={!url.trim()} onClick={() => void dev.attach(url.trim())}>
          Attach
        </Action>
      </div>
    </div>
  )
}

/**
 * Everything listening on this machine.
 *
 * The remote half of "port forwarding" needs a container to forward from, and
 * there is not one. This is the half that gets used regardless: the agent
 * started a backend on one port and a front end on another, and you want to
 * look at either without going to find out which is which.
 *
 * Nothing is hidden for being unrecognised — the whole point is finding the
 * server you did not expect — but the ones that look like development servers
 * sort first, and the machinery every Mac runs is filtered out entirely.
 */
function Ports() {
  const ports = useDev((state) => state.ports)
  if (ports.length === 0) return null

  return (
    <div className="w-full max-w-[22rem]">
      <div className="flex items-center gap-2 pb-1">
        <span className="text-label text-faint">Listening now</span>
        <button
          type="button"
          onClick={() => void dev.scan()}
          className="pressable ml-auto rounded px-1 text-label text-faint hover:text-foreground"
        >
          Rescan
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {ports.slice(0, 8).map((entry) => (
          <button
            key={entry.port}
            type="button"
            onClick={() => void dev.attach(entry.url)}
            title={`${entry.command} · pid ${entry.pid}${entry.loopbackOnly ? " · loopback only" : ""}`}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left",
              "transition-colors duration-100 hover:bg-fill-hover"
            )}
          >
            <span className="tabular shrink-0 text-ui text-foreground/85">{entry.port}</span>
            <span className="min-w-0 flex-1 truncate text-label text-faint">{entry.command}</span>
            {entry.likely ? (
              <span className="shrink-0 text-label text-added">dev</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The server's own output, because a blank preview is usually explained there. */
function Logs() {
  const lines = useDev((state) => state.lines)
  const status = useDev((state) => state.status)
  const [open, setOpen] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  // Failure opens the log without being asked: that is the one time you were
  // certainly about to.
  const [lastStatus, setLastStatus] = useState(status)
  if (lastStatus !== status) {
    setLastStatus(status)
    if (status === "failed") setOpen(true)
  }

  useEffect(() => {
    if (open && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [lines, open])

  if (lines.length === 0) return null

  return (
    <div className="shrink-0 border-t border-hairline">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-label text-faint transition-colors duration-100 hover:text-foreground"
      >
        <TerminalIcon className="size-3 shrink-0" />
        <span>Server output</span>
        <span className="tabular ml-auto">{lines.length}</span>
      </button>
      {open ? (
        <div
          ref={scroller}
          className="max-h-40 overflow-y-auto overscroll-contain border-t border-hairline px-2 py-1.5"
        >
          {lines.map((line, index) => (
            <p key={index} className="font-mono text-label leading-relaxed text-faint">
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
