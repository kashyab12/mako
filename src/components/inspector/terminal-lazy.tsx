import { lazy, Suspense } from "react"

const Panel = lazy(() =>
  import("@/components/inspector/terminal-panel").then((module) => ({
    default: module.TerminalPanel,
  }))
)

export function TerminalPanel() {
  return (
    <Suspense fallback={<p className="shimmer p-3 text-ui">Loading terminal…</p>}>
      <Panel />
    </Suspense>
  )
}
