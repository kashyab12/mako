import { lazy, Suspense } from "react"

/**
 * Pierre's diff engine drags in a syntax-highlighting runtime, which has no
 * business being in the boot path — it loads the first time the panel is
 * opened and never again.
 */
const Panel = lazy(() =>
  import("@/components/inspector/changes-panel").then((module) => ({
    default: module.ChangesPanel,
  }))
)

export function ChangesPanel() {
  return (
    <Suspense fallback={<p className="shimmer p-3 text-ui">Loading diffs…</p>}>
      <Panel />
    </Suspense>
  )
}
