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
  clampDockHeight,
  COMPANION_MIN_DEFAULT,
  fitsBeside,
} from "@/components/stage/stage-width"
import { cn } from "@/lib/utils"
import { ArrowLeftIcon } from "lucide-react"
import type { TabStage } from "@/state/stage"

/** Identity-stable fallback so the selector never allocates per render. */
const NO_COMPANION: TabStage = {
  companion: null,
  dock: null,
  presentation: "beside",
}

/**
 * The stage: chat, one reading companion beside it, and an independent dock.
 *
 * The chat card is rendered first, in a stable position, and is *hidden*
 * rather than unmounted when a companion covers the stage — opening a diff
 * must never cost the transcript its scroll position or its stream. This
 * container selects only the stage layout itself; git, meta, and messages
 * belong to the cards, so a token or a git flush cannot re-render the frame.
 */
export function Stage() {
  const activeId = useTabs((state) => state.activeId)
  const tabStage = useStage((state) => state.byTab[activeId] ?? NO_COMPANION)
  const surfaces = useSurfaces()
  const surfaceWidths = usePrefs((prefs) => prefs.surfaceWidths)
  const surfaceHeights = usePrefs((prefs) => prefs.surfaceHeights)

  // On first boot, restore the companion you usually work with. Tab ids do
  // not survive a relaunch, so this is the only cross-launch memory needed.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !activeId) return
    seeded.current = true
    const last = prefsStore.get().lastCompanion
    const remembered = surfaces.find((surface) => surface.id === last)
    if (remembered && remembered.placement !== "bottom") stage.open(remembered.id)
    else if (last) setPref("lastCompanion", null)
  }, [activeId, surfaces])

  // The stage measures itself so the clamp and the beside→over degradation
  // are render-time facts, not stored state. Resizes are rare and the two
  // cards are memoized, so the re-render is cheap.
  const stageRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState<
    { width: number; height: number } | undefined
  >(undefined)
  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const bounds = entries[0]?.contentRect
      if (!bounds?.width || !bounds.height) return
      setAvailable((current) =>
        current?.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height }
      )
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const companionRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const [workbenchWidth, setWorkbenchWidth] = useState(640)
  const [workbenchHeight, setWorkbenchHeight] = useState(360)
  const sideSurface = tabStage.companion
    ? surfaces.find((entry) => entry.id === tabStage.companion)
    : undefined
  const dockSurface = tabStage.dock
    ? surfaces.find((entry) => entry.id === tabStage.dock)
    : undefined
  const min = Math.max(sideSurface?.minWidth ?? 0, COMPANION_MIN_DEFAULT)
  const width = sideSurface
    ? clampCompanionWidth({
        width: surfaceWidths[sideSurface.id] ?? min,
        available: available?.width,
        min,
      })
    : 0
  const dockMin = dockSurface?.minHeight ?? 180
  const dockMax = clampDockHeight({
    height: 9999,
    available: available?.height,
    min: dockMin,
  })
  const dockHeight = dockSurface
    ? clampDockHeight({
        height: surfaceHeights[dockSurface.id] ?? 280,
        available: available?.height,
        min: dockMin,
      })
    : 0
  // A split that cannot afford both minimums renders as "over" without
  // rewriting the stored preference; widening the window restores it.
  const wantsCover = Boolean(
    sideSurface &&
      (tabStage.presentation === "over" || !fitsBeside(available?.width, min))
  )
  // Files take a stable workspace beside the mounted chat. At narrow widths
  // that pair stacks vertically, while a companion steps aside without being
  // closed so it can return when the workbench leaves.
  const viewerUp = useViewer((state) => Boolean(state.path))
  const searchUp = useSearch((state) => state.open)
  const covered = wantsCover && !viewerUp && !searchUp
  const companionHidden = viewerUp || (wantsCover && searchUp)
  const viewerBelow = viewerUp && Boolean(available && available.width < 940)
  const availableBodyHeight = Math.max(
    360,
    (available?.height ?? 800) - (dockSurface ? dockHeight + 9 : 0)
  )
  const workbenchMax = viewerBelow
    ? Math.max(180, availableBodyHeight - 220)
    : Math.max(280, (available?.width ?? 1200) - 380)
  const workbenchMin = Math.min(viewerBelow ? 240 : 420, workbenchMax)
  const workbenchSize = Math.min(
    workbenchMax,
    Math.max(workbenchMin, viewerBelow ? workbenchHeight : workbenchWidth)
  )

  return (
    <div
      ref={stageRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1",
          viewerBelow && "flex-col"
        )}
      >
        <ChatCard hidden={covered} />

        {viewerUp ? (
          <>
            <Divider
              side={viewerBelow ? "bottom" : "right"}
              size={workbenchSize}
              min={workbenchMin}
              max={workbenchMax}
              className={viewerBelow ? "mx-2 w-auto" : undefined}
              onResize={(next) => {
                if (!workbenchRef.current) return
                if (viewerBelow) workbenchRef.current.style.height = `${next}px`
                else workbenchRef.current.style.width = `${next}px`
              }}
              onCommit={(next) => {
                if (viewerBelow) setWorkbenchHeight(next)
                else setWorkbenchWidth(next)
              }}
            />
            <FileViewer
              workspaceRef={workbenchRef}
              style={viewerBelow ? { height: workbenchSize } : { width: workbenchSize }}
              className={viewerBelow ? "mx-2 mb-2 shrink-0" : "m-2 ml-0 shrink-0"}
            />
          </>
        ) : null}

        {sideSurface && !covered && !companionHidden ? (
          <Divider
            side="right"
            size={width}
            min={min}
            max={
              available
                ? Math.max(available.width - 450 - 24, min)
                : 9999
            }
            onResize={(next) => {
              if (companionRef.current)
                companionRef.current.style.width = `${next}px`
            }}
            onCommit={(next) =>
              setPref("surfaceWidths", {
                ...prefsStore.get().surfaceWidths,
                [sideSurface.id]: next,
              })
            }
          />
        ) : null}

        {sideSurface ? (
          <div
            ref={companionRef}
            style={covered || companionHidden ? undefined : { width }}
            className={cn(
              "card relative m-2 ml-0 flex min-h-0 flex-col overflow-hidden",
              covered && "ml-2 min-w-0 flex-1",
              companionHidden && "hidden"
            )}
          >
            {covered ? (
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-2.5 text-label text-faint">
                <span className="min-w-0 flex-1 truncate">
                  {sideSurface.label} · conversation hidden at this width
                </span>
                <button
                  type="button"
                  onClick={() => stage.close()}
                  className="pressable flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground"
                >
                  <ArrowLeftIcon className="size-3" />
                  Conversation
                </button>
              </div>
            ) : null}
            <CompanionBody render={sideSurface.render} />
          </div>
        ) : null}
      </div>

      {dockSurface ? (
        <>
          <Divider
            side="bottom"
            size={dockHeight}
            min={dockMin}
            max={dockMax}
            className="mx-2 w-auto"
            onResize={(next) => {
              if (dockRef.current) dockRef.current.style.height = `${next}px`
            }}
            onCommit={(next) =>
              setPref("surfaceHeights", {
                ...prefsStore.get().surfaceHeights,
                [dockSurface.id]: next,
              })
            }
          />
          <div
            ref={dockRef}
            style={{ height: dockHeight }}
            className="card relative mx-2 mb-2 flex shrink-0 flex-col overflow-hidden"
          >
            <CompanionBody render={dockSurface.render} />
          </div>
        </>
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
  const viewingPath = useThreads((state) => state.viewing?.ref.path)
  const viewing = useThreads((state) => Boolean(state.viewing) || state.viewingBusy)
  const live = useAcp((state) => Boolean(state.session) || state.starting)
  const liveThreadPath = useAcp((state) => state.threadPath)
  if (viewing && (!live || viewingPath !== liveThreadPath)) return <ThreadViewer />
  if (live) return <AcpPanel />
  return <Transcript />
}
