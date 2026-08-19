import { Component, type ErrorInfo, type ReactNode } from "react"
import { Action } from "@/components/ui/kit"
import { getMako, hasBridge } from "@/lib/bridge"
import { MakoMark } from "@/components/ui/mako-mark"

/**
 * The last line before a white window.
 *
 * A component that throws unmounts the whole tree, and React's default for
 * that is a blank page with the reason only in a console nobody has open. That
 * is the failure mode this app has been bitten by most: something breaks, the
 * window shows nothing, and there is no thread to pull.
 *
 * So: say what happened, say where it is written down, and offer the two
 * things that actually help — try again without losing the process, or reload
 * the window. The agent runtimes live in the main process and are untouched by
 * either, so the conversation is still there afterwards.
 */
interface State {
  error?: Error
  info?: string
  /** Bumped on retry so the subtree remounts rather than re-throwing. */
  attempt: number
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info: info.componentStack ?? undefined })
    if (!hasBridge()) return
    void getMako()
      .reportCrash("renderer-error", {
        message: error.message,
        stack: `${error.stack ?? ""}\n--- component stack ---${info.componentStack ?? ""}`,
        source: "react",
      })
      .catch(() => {
        // Reporting the crash must never become the crash.
      })
  }

  private retry = () => {
    this.setState((state) => ({ error: undefined, info: undefined, attempt: state.attempt + 1 }))
  }

  private revealReport = async () => {
    if (!hasBridge()) return
    const dir = await getMako().crashesDir()
    await getMako().revealPath(dir)
  }

  render() {
    const { error, info } = this.state
    if (!error) return <div key={this.state.attempt}>{this.props.children}</div>

    return (
      <div className="flex h-svh flex-col items-center justify-center gap-5 bg-background px-8 text-foreground">
        <MakoMark className="size-8 text-foreground/40" />
        <div className="max-w-dialog text-center">
          <h1 className="text-[15px] font-medium">Something in the interface broke</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            The agent kept running — it lives in a separate process, so nothing was lost. A report
            was written locally; nothing was sent anywhere.
          </p>
        </div>

        <pre className="max-h-40 w-full max-w-dialog overflow-auto rounded-lg bg-surface p-3 text-left font-mono text-[11px] leading-relaxed text-faint ring-1 ring-hairline">
          {error.message}
          {info ? info.split("\n").slice(0, 6).join("\n") : ""}
        </pre>

        <div className="flex items-center gap-2">
          <Action tone="outline" size="md" onClick={this.retry}>
            Try again
          </Action>
          <Action tone="outline" size="md" onClick={() => location.reload()}>
            Reload the window
          </Action>
          {hasBridge() ? (
            <Action tone="ghost" size="md" onClick={() => void this.revealReport()}>
              Show local report
            </Action>
          ) : null}
          <Action
            tone="ghost"
            size="md"
            onClick={() => {
              const text = `${error.message}\n${error.stack ?? ""}\n${info ?? ""}`
              void navigator.clipboard.writeText(text)
            }}
          >
            Copy the report
          </Action>
        </div>
      </div>
    )
  }
}
