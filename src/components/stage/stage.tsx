import { memo, useEffect, useRef, useState } from "react"
import { Composer } from "@/components/composer/composer"
import { Transcript } from "@/components/transcript/transcript"
import { ThreadViewer } from "@/components/viewer/thread-viewer"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { FileViewer } from "@/components/viewer/file-viewer"
import { SearchView } from "@/components/search/search-view"
import { Divider } from "@/components/shell/divider"
import { useSurfaces } from "@/extend/surfaces"
import { stage, useStage } from "@/state/stage"
import { useTabs } from "@/state/tabs"
import { useThreads } from "@/state/threads"
import { useAcp } from "@/state/acp"
import { useViewer } from "@/state/viewer"
import { useSearch } from "@/state/search"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import {
  clampCompanionWidth,
  COMPANION_MIN_DEFAULT,
  fitsBeside,
} from "@/components/stage/stage-width"
import { cn } from "@/lib/utils"

/**
 * The stage: the chat card, and at most one companion card beside it.
 *
 * The chat card is rendered first, in a stable position, and is *hidden*
 * rather than unmounted when a companion covers the stage — opening a diff
 * must never cost the transcript its scroll position or its stream. This
 * container selects only the stage layout itself; git, meta, and messages
 * belong to the cards, so a token or a git flush cannot re-render the frame.
 */
export function Stage() {
  const activeId = useTabs((state) => state.activeId)
  const tabStage = useStage(
    (state) => state.byTab[activeId] ?? { companion: null, presentation: "beside" as const }
  )
  const surfaces = useSurfaces()
  const surfaceWidths = usePrefs((prefs) => prefs.surfaceWidths)

  // On first boot, restore the companion you usually work with. Tab ids do
  // not survive a relaunch, so this is the only cross-launch memory needed.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !activeId) return
    seeded.current = true
    const last = prefsStore.get().lastCompanion
    if (last) stage.open(last)
  }, [activeId])

  // The stage measures itself so the clamp and the beside→over degradation
  // are render-time facts, not stored state. Resizes are rare and the two
  // cards are memoized, so the re-render is cheap.
  const row = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState<number | undefined>(undefined)
  useEffect(() => {
    const node = row.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setAvailable((current) => (current === width ? current : width))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const companionRef = useRef<HTMLDivElement>(null)
  const surface = tabStage.companion
    ? surfaces.find((entry) => entry.id === tabStage.companion)
    : undefined
  const min = Math.max(surface?.minWidth ?? 0, COMPANION_MIN_DEFAULT)
  const width = surface
    ? clampCompanionWidth({
        width: surfaceWidths[surface.id] ?? min,
        available,
        min,
      })
    : 0
  // A split that cannot afford both minimums renders as "over" without
  // rewriting the stored preference; widening the window restores it.
  const wantsCover = Boolean(
    surface && (tabStage.presentation === "over" || !fitsBeside(available, min))
  )
  // The file viewer and search ride on the chat card; while either is up,
  // the chat must win even when the width degraded the split — otherwise
  // "open a file" renders into a hidden card and nothing appears. The
  // companion steps aside (hidden, not closed) until the overlay leaves.
  const viewerUp = useViewer((state) => Boolean(state.path))
  const searchUp = useSearch((state) => state.open)
  const overlayUp = viewerUp || searchUp
  const covered = wantsCover && !overlayUp
  const companionHidden = wantsCover && overlayUp

  return (
    <div ref={row} className="relative flex min-h-0 min-w-0 flex-1">
      <ChatCard hidden={covered} />

      {surface && !covered && !companionHidden ? (
        <Divider
          side="right"
          width={width}
          min={min}
          max={available ? Math.max(available - 450 - 24, min) : 9999}
          onResize={(next) => {
            if (companionRef.current) companionRef.current.style.width = `${next}px`
          }}
          onCommit={(next) =>
            setPref("surfaceWidths", {
              ...prefsStore.get().surfaceWidths,
              [surface.id]: next,
            })
          }
        />
      ) : null}

      {surface ? (
        <div
          ref={companionRef}
          style={covered || companionHidden ? undefined : { width }}
          className={cn(
            "card relative m-2 ml-0 flex min-h-0 flex-col overflow-hidden",
            covered && "ml-2 min-w-0 flex-1",
            companionHidden && "hidden"
          )}
        >
          <CompanionBody render={surface.render} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The conversation, its composer, and the overlays that ride on it. Memoized
 * so stage-frame re-renders (a resize, a companion swap) reuse the subtree —
 * the transcript must keep scroll and stream across every stage change.
 */
const ChatCard = memo(function ChatCard({ hidden }: { hidden: boolean }) {
  return (
    <main
      className={cn(
        "card relative m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        hidden && "hidden"
      )}
    >
      <ConversationSurface />
      <Composer />
      {/* Over the conversation column only. The rail stays reachable, so you
          can walk the tree with a file already open. */}
      <FileViewer />
      <SearchView />
    </main>
  )
})

const CompanionBody = memo(function CompanionBody({
  render: Render,
}: {
  render: React.ComponentType<Record<never, never>>
}) {
  return <Render />
})

/**
 * The chat column's middle. The composer below is the same for every
 * provider and routes to whoever owns the open conversation.
 */
function ConversationSurface() {
  const viewing = useThreads((state) => Boolean(state.viewing) || state.viewingBusy)
  const live = useAcp((state) => Boolean(state.session) || state.starting)
  if (live) return <AcpPanel />
  return viewing ? <ThreadViewer /> : <Transcript />
}
