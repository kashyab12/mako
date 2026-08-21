import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react"
import { Action, IconAction } from "@/components/ui/kit"
import { Divider } from "@/components/shell/divider"
import { getMako } from "@/lib/bridge"
import { prefsStore } from "@/state/prefs"
import {
  viewer,
  useViewer,
  type ViewerDocument,
  type ViewerPane,
} from "@/state/viewer"
import { cn } from "@/lib/utils"
import {
  AtSignIcon,
  BookOpenIcon,
  Code2Icon,
  Columns2Icon,
  ExternalLinkIcon,
  PinIcon,
  RefreshCwIcon,
  Rows2Icon,
  XIcon,
} from "lucide-react"

/** The highlighting runtime is heavy and nobody has opened a file yet. */
const View = lazy(() =>
  import("@/components/viewer/file-view").then((module) => ({ default: module.FileView }))
)

/**
 * A renderer-local file workbench beside the mounted conversation.
 *
 * Tabs belong to a pane, transient previews are replaced by the state layer,
 * and the optional second pane writes drag sizes directly to its DOM node so
 * highlighting and Markdown do not re-render on every pointer move.
 */
export function FileViewer({
  className,
  style,
  workspaceRef,
}: {
  className?: string
  style?: CSSProperties
  workspaceRef: RefObject<HTMLDivElement | null>
}) {
  const path = useViewer((state) => state.path)
  const documents = useViewer((state) => state.documents)
  const panes = useViewer((state) => state.panes)
  const focusedPaneId = useViewer((state) => state.focusedPaneId)
  const split = useViewer((state) => state.split)
  const panesHost = useRef<HTMLDivElement>(null)
  const secondary = useRef<HTMLDivElement>(null)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [paneWidth, setPaneWidth] = useState(420)
  const [paneHeight, setPaneHeight] = useState(320)

  useEffect(() => {
    if (!path) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        viewer.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [path])

  useEffect(() => {
    const node = panesHost.current
    if (!node) return
    const update = (width: number, height: number) => {
      setBounds((current) =>
        current.width === width && current.height === height ? current : { width, height }
      )
    }
    const initial = node.getBoundingClientRect()
    update(initial.width, initial.height)
    const observer = new ResizeObserver((entries) => {
      const content = entries[0]?.contentRect
      if (!content) return
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
      resizeTimer.current = setTimeout(() => update(content.width, content.height), 80)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (resizeTimer.current) clearTimeout(resizeTimer.current)
    }
  }, [path])

  if (!path) return null

  const hasSecondPane = panes.length === 2
  const horizontal = split === "right"
  const secondMin = horizontal ? Math.min(240, bounds.width / 2) : Math.min(180, bounds.height / 2)
  const secondMax = horizontal
    ? Math.max(secondMin, bounds.width - secondMin - 1)
    : Math.max(secondMin, bounds.height - secondMin - 1)
  const secondSize = clamp(horizontal ? paneWidth : paneHeight, secondMin, secondMax)

  return (
    <div
      ref={workspaceRef}
      style={style}
      className={cn(
        "card animate-enter relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface",
        className
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-ui font-medium text-muted-foreground">
          Files
        </span>
        <IconAction
          label="Split right"
          size="xs"
          data-on={hasSecondPane && split === "right"}
          onClick={() => viewer.splitPane("right")}
        >
          <Columns2Icon />
        </IconAction>
        <IconAction
          label="Split down"
          size="xs"
          data-on={hasSecondPane && split === "down"}
          onClick={() => viewer.splitPane("down")}
        >
          <Rows2Icon />
        </IconAction>
        <IconAction label="Close file workspace" keys={["Esc"]} size="xs" onClick={() => viewer.close()}>
          <XIcon />
        </IconAction>
      </div>

      <div
        ref={panesHost}
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          hasSecondPane && !horizontal && "flex-col"
        )}
      >
        <FilePane
          pane={panes[0]}
          documents={documents}
          focused={focusedPaneId === panes[0].id}
          canClosePane={false}
        />
        {hasSecondPane ? (
          <>
            <Divider
              side={horizontal ? "right" : "bottom"}
              size={secondSize}
              min={secondMin}
              max={secondMax}
              onResize={(next) => {
                if (!secondary.current) return
                if (horizontal) secondary.current.style.width = `${next}px`
                else secondary.current.style.height = `${next}px`
              }}
              onCommit={(next) => {
                if (horizontal) setPaneWidth(next)
                else setPaneHeight(next)
              }}
            />
            <div
              ref={secondary}
              style={horizontal ? { width: secondSize } : { height: secondSize }}
              className="flex min-h-0 min-w-0 shrink-0"
            >
              <FilePane
                pane={panes[1]}
                documents={documents}
                focused={focusedPaneId === panes[1].id}
                canClosePane
              />
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

const FilePane = memo(function FilePane({
  pane,
  documents,
  focused,
  canClosePane,
}: {
  pane: ViewerPane
  documents: Record<string, ViewerDocument>
  focused: boolean
  canClosePane: boolean
}) {
  const document = pane.activeId ? documents[pane.activeId] : undefined

  return (
    <section
      aria-label="File pane"
      onPointerDown={() => viewer.focusPane(pane.id)}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-surface",
        focused && "ring-1 ring-border ring-inset"
      )}
    >
      <div className="flex h-9 shrink-0 border-b border-hairline bg-raised/35">
        <div role="tablist" className="flex min-w-0 flex-1 overflow-x-auto">
          {pane.tabIds.map((id) => {
            const tab = documents[id]
            if (!tab) return null
            const active = id === pane.activeId
            return (
              <div
                key={id}
                className={cn(
                  "group flex h-full min-w-36 max-w-60 shrink-0 items-center border-r border-hairline",
                  active ? "bg-surface text-foreground" : "text-faint hover:bg-fill-hover"
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={tab.pinned ? tab.path : `${tab.path} · preview, double-click to pin`}
                  onClick={() => viewer.activate(pane.id, id)}
                  onDoubleClick={() => viewer.pin(id)}
                  className={cn(
                    "min-w-0 flex-1 truncate px-2 text-left font-mono text-label",
                    !tab.pinned && "italic"
                  )}
                >
                  {tab.pinned ? <PinIcon className="mr-1 inline size-2.5 text-faint" /> : null}
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => viewer.closeTab(pane.id, id)}
                  className="pressable mr-1 flex size-5 shrink-0 items-center justify-center rounded text-faint opacity-70 hover:bg-fill-hover hover:text-foreground group-hover:opacity-100"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        {canClosePane ? (
          <IconAction
            label="Close pane"
            size="xs"
            className="m-1"
            onClick={() => viewer.closePane(pane.id)}
          >
            <XIcon />
          </IconAction>
        ) : null}
      </div>

      {document ? <DocumentView document={document} /> : null}
    </section>
  )
})

function DocumentView({ document }: { document: ViewerDocument }) {
  const previewable = document.kind === "file" && hasRichPreview(document.path)
  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <span className="min-w-0 flex-1 truncate px-1 font-mono text-label text-faint" title={document.path}>
          {document.path}
        </span>
        {document.file?.truncated ? (
          <span className="shrink-0 rounded bg-raised px-1.5 py-px text-label text-caution">
            first 2 MB
          </span>
        ) : null}
        {previewable ? (
          <Action
            size="xs"
            aria-pressed={document.renderMode === "preview"}
            onClick={() =>
              viewer.setRenderMode(
                document.id,
                document.renderMode === "preview" ? "source" : "preview"
              )
            }
          >
            {document.renderMode === "preview" ? <Code2Icon /> : <BookOpenIcon />}
            <span>
              {document.renderMode === "preview" ? "Source" : "Preview"}
            </span>
          </Action>
        ) : null}
        {document.kind === "file" ? (
          <>
            <IconAction
              label="Mention this file in the composer"
              size="xs"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("mako:insert", { detail: `@${document.path} ` })
                )
              }}
            >
              <AtSignIcon />
            </IconAction>
            <IconAction
              label="Re-read from disk"
              size="xs"
              onClick={() => viewer.refresh(document.path)}
            >
              <RefreshCwIcon />
            </IconAction>
            <IconAction
              label="Open in your editor"
              size="xs"
              onClick={() =>
                void getMako().openInEditor(
                  document.path,
                  prefsStore.get().externalEditor
                )
              }
            >
              <ExternalLinkIcon />
            </IconAction>
          </>
        ) : null}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-auto", document.loading && "opacity-60")}>
        {document.error ? (
          <p className="p-4 text-ui text-removed">{document.error}</p>
        ) : document.kind === "diff" && document.diff ? (
          <CenterDiff diffs={document.diff.diffs} note={document.diff.note} />
        ) : document.kind === "file" && document.file ? (
          <Suspense fallback={<p className="shimmer p-4 text-ui">Opening…</p>}>
            <View file={document.file} line={document.line} mode={document.renderMode} />
          </Suspense>
        ) : (
          <p className="shimmer p-4 text-ui">Reading {document.path}…</p>
        )}
      </div>
    </>
  )
}

/**
 * The diff engine, loaded only when a diff actually opens here — it carries
 * a syntax-highlighting runtime that has no business in the boot path.
 */
const LazyDiff = lazy(async () => {
  const [{ MultiFileDiff, Virtualizer }, { prefsStore }] = await Promise.all([
    import("@pierre/diffs/react"),
    import("@/state/prefs"),
  ])
  function Center({ diffs, note }: { diffs: import("@/lib/types").GitDiff[]; note?: string }) {
    const theme = prefsStore.get().theme
    const showable = diffs.filter((diff) => !diff.binary && (diff.oldFile || diff.newFile))
    if (showable.length === 0) {
      return <p className="p-4 text-ui text-faint">No text content to compare.</p>
    }
    return (
      <Virtualizer className="min-h-full">
        {showable.map((diff) => (
          <MultiFileDiff
            key={diff.path}
            {...(diff.oldFile && diff.newFile
              ? { oldFile: diff.oldFile, newFile: diff.newFile }
              : diff.newFile
                ? { oldFile: null, newFile: diff.newFile }
                : { oldFile: diff.oldFile!, newFile: null })}
            options={{
              themeType: theme === "light" ? "light" : "dark",
              diffStyle: "split",
            }}
          />
        ))}
        {note ? <p className="p-3 text-label text-faint">{note}</p> : null}
      </Virtualizer>
    )
  }
  return { default: Center }
})

function CenterDiff({ diffs, note }: { diffs: import("@/lib/types").GitDiff[]; note?: string }) {
  return (
    <Suspense fallback={<p className="shimmer p-4 text-ui">Loading diff…</p>}>
      <LazyDiff diffs={diffs} note={note} />
    </Suspense>
  )
}

function hasRichPreview(path: string) {
  return /\.(?:csv|md|markdown|mdx|tsv)$/i.test(path)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
