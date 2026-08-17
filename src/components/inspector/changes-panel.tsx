import { useCallback, useEffect, useMemo, useState } from "react"
import { MultiFileDiff, Virtualizer } from "@pierre/diffs/react"
import { Blank, IconAction } from "@/components/ui/kit"
import { CommitBox } from "@/components/inspector/commit-box"
import { PullRequestCard } from "@/components/inspector/pull-request"
import { Slot } from "@/extend/slot"
import { actions, useSession } from "@/state/session"
import { getPi } from "@/lib/bridge"
import { buildFileTree, type TreeRow } from "@/lib/file-tree"
import { cn } from "@/lib/utils"
import { prefsStore, setPref, togglePref, usePrefs } from "@/state/prefs"
import type { GitDiff, GitFile } from "@/lib/types"
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  FolderIcon,
  MinusIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"

/**
 * The working tree.
 *
 * A folded directory tree over the changed files, staging on the row, and a
 * commit box beneath. Contents are fetched one file at a time on selection, so
 * a repo with a thousand dirty files still opens instantly.
 */
const MARK: Record<GitFile["status"], { glyph: string; tone: string; title: string }> = {
  added: { glyph: "A", tone: "text-added", title: "Added" },
  untracked: { glyph: "U", tone: "text-added", title: "Untracked" },
  modified: { glyph: "M", tone: "text-caution", title: "Modified" },
  deleted: { glyph: "D", tone: "text-removed", title: "Deleted" },
  renamed: { glyph: "R", tone: "text-foreground/70", title: "Renamed" },
}

export function ChangesPanel() {
  const git = useSession((state) => state.git)
  const theme = usePrefs((prefs) => prefs.theme)
  const collapsed = usePrefs((prefs) => prefs.collapsedDirs)
  const files = useMemo(() => git?.files ?? [], [git])

  const autoOpenDiff = usePrefs((prefs) => prefs.autoOpenDiff)
  const [selected, setSelected] = useState<string>()
  const [diff, setDiff] = useState<GitDiff>()

  const rows = useMemo(() => buildFileTree(files, collapsed), [collapsed, files])
  const staged = useMemo(() => files.filter((file) => file.staged).length, [files])

  // With the diff pane closed the list is the whole panel, so nothing is
  // "selected" and no file contents are fetched at all.
  const active = autoOpenDiff ? (files.find((file) => file.path === selected) ?? files[0]) : undefined
  const path = active?.path
  const ready = diff !== undefined && diff.path === path

  useEffect(() => {
    if (!path) return
    let cancelled = false
    void getPi()
      .gitDiff(path)
      .then((next) => {
        if (!cancelled) setDiff(next)
      })
      .catch(() => {
        if (!cancelled) setDiff({ path, binary: false, oldFile: null, newFile: null })
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const toggleDir = useCallback((key: string) => {
    // Read through the store rather than the hook value so the callback stays
    // stable and the row components keep their memoization.
    const current = prefsStore.get().collapsedDirs
    setPref(
      "collapsedDirs",
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
    )
  }, [])

  const toggleStage = useCallback(async (file: GitFile) => {
    const pi = getPi()
    if (file.staged) await pi.gitUnstage([file.path])
    else await pi.gitStage([file.path])
  }, [])

  const stagePaths = useCallback(async (paths: string[], stage: boolean) => {
    if (paths.length === 0) return
    const pi = getPi()
    // One call for the whole folder: `git add -- a b c` is atomic where a loop
    // would emit a status refresh per file and flicker the list.
    if (stage) await pi.gitStage(paths)
    else await pi.gitUnstage(paths)
  }, [])

  if (files.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <Blank
            icon={<CheckCircle2Icon />}
            title={git?.root ? "Working tree is clean" : "Not a git repository"}
            body={
              git?.root
                ? `Nothing has changed on ${git.branch ?? "this branch"}. Edits appear here as the agent makes them.`
                : "Run git init in this folder to track changes and see diffs here."
            }
          />
        </div>
        {/* Still here on a clean tree — a branch you have finished committing
            is exactly when you want to open the pull request. */}
        <PullRequestCard />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-2.5 text-[10.5px] text-faint">
        <span>
          {files.length} changed
          {staged > 0 ? ` · ${staged} staged` : ""}
        </span>
        <span className="tabular text-added">
          +{files.reduce((sum, file) => sum + file.insertions, 0)}
        </span>
        <span className="tabular text-removed">
          −{files.reduce((sum, file) => sum + file.deletions, 0)}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconAction
            label={staged === files.length ? "Unstage everything" : "Stage everything"}
            size="xs"
            onClick={() =>
              void (staged === files.length
                ? getPi().gitUnstageAll()
                : getPi().gitStageAll())
            }
          >
            {staged === files.length ? <MinusIcon /> : <PlusIcon />}
          </IconAction>
          <IconAction
            label={autoOpenDiff ? "Hide the diff" : "Show the diff"}
            size="xs"
            data-on={autoOpenDiff || undefined}
            onClick={() => togglePref("autoOpenDiff")}
          >
            {autoOpenDiff ? <PanelBottomCloseIcon /> : <PanelBottomOpenIcon />}
          </IconAction>
          <IconAction label="Refresh" size="xs" onClick={() => void actions.refreshGit()}>
            <RefreshCwIcon />
          </IconAction>
        </div>
      </div>

      <div
        className={cn(
          "min-h-0 overflow-y-auto overscroll-contain px-1 py-1",
          autoOpenDiff ? "max-h-[34%] shrink-0" : "flex-1"
        )}
      >
        {rows.map((row) =>
          row.kind === "dir" ? (
            <DirRow key={row.key} row={row} onToggle={toggleDir} onStage={stagePaths} />
          ) : (
            <FileRow
              key={row.key}
              row={row}
              active={active?.path === row.file.path}
              onSelect={setSelected}
              onToggleStage={toggleStage}
            />
          )
        )}
      </div>

      {autoOpenDiff ? (
        <div className="relative flex min-h-0 flex-1 flex-col border-t border-hairline">
          {/* Closing from the pane itself, not only from the header: the thing
              you want gone is the thing your pointer is already over. */}
          <div className="flex h-6 shrink-0 items-center gap-2 px-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">
              {active?.path ?? ""}
            </span>
            <IconAction
              label="Close the diff"
              size="xs"
              onClick={() => togglePref("autoOpenDiff")}
            >
              <XIcon />
            </IconAction>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
        {!ready ? (
          <p className="shimmer p-3 text-[11.5px]">Loading diff…</p>
        ) : diff.binary || (!diff.oldFile && !diff.newFile) ? (
          <p className="p-3 text-[11.5px] text-faint">
            {diff.binary ? "Binary file — no text diff." : "No text content to compare."}
          </p>
        ) : (
          <Virtualizer className="min-h-full">
            <MultiFileDiff
              {...(diff.oldFile && diff.newFile
                ? { oldFile: diff.oldFile, newFile: diff.newFile }
                : diff.newFile
                  ? { oldFile: null, newFile: diff.newFile }
                  : { oldFile: diff.oldFile!, newFile: null })}
              options={{ themeType: theme === "light" ? "light" : "dark" }}
            />
          </Virtualizer>
            )}
          </div>
        </div>
      ) : null}

      <CommitBox staged={staged} total={files.length} />
      <PullRequestCard />
    </div>
  )
}

/**
 * A staging checkbox. Directories carry the same control as files and act on
 * everything beneath them, with a partial state for the common case where the
 * agent touched several files in a folder and you only staged some.
 */
function StageBox({
  state,
  label,
  onToggle,
}: {
  state: "on" | "off" | "partial"
  label: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "partial" ? "mixed" : state === "on"}
      title={label}
      onClick={(event) => {
        // The row underneath is a click target too; staging must not also
        // expand a folder or open a diff.
        event.stopPropagation()
        onToggle()
      }}
      className={cn(
        "pressable flex size-3.5 shrink-0 items-center justify-center rounded-[3px] ring-1 ring-inset",
        "[transition:background-color_120ms_ease,box-shadow_120ms_ease]",
        state === "off"
          ? "ring-border group-hover:ring-foreground/40"
          : "bg-foreground/85 ring-foreground/85"
      )}
    >
      {state === "on" ? (
        <svg viewBox="0 0 10 10" className="size-2.5 text-background" aria-hidden>
          <path
            d="M1.5 5.2 4 7.5 8.5 2.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : state === "partial" ? (
        <span className="block h-[1.5px] w-[7px] rounded-full bg-background" />
      ) : null}
    </button>
  )
}

function DirRow({
  row,
  onToggle,
  onStage,
}: {
  row: Extract<TreeRow, { kind: "dir" }>
  onToggle: (key: string) => void
  onStage: (paths: string[], stage: boolean) => void
}) {
  const state = row.staged === 0 ? "off" : row.staged === row.files ? "on" : "partial"

  return (
    <div
      style={{ paddingInlineStart: 4 + row.depth * 11 }}
      className="group flex h-6 items-center gap-1.5 rounded pr-1 transition-colors duration-100 hover:bg-raised"
    >
      <StageBox
        state={state}
        // Partially staged reads as "not yet done", so the useful action is to
        // finish staging it rather than to clear what you already picked.
        label={state === "on" ? `Unstage ${row.label}` : `Stage all of ${row.label}`}
        onToggle={() => onStage(row.paths, state !== "on")}
      />
      <button
        type="button"
        onClick={() => onToggle(row.key)}
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-faint transition-transform duration-150",
            !row.collapsed && "rotate-90"
          )}
        />
        <FolderIcon className="size-3 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {row.label}
        </span>
        <span className="tabular shrink-0 pr-1 text-[10px] text-faint">
          {row.staged > 0 && row.staged < row.files ? `${row.staged}/${row.files}` : row.files}
        </span>
      </button>
    </div>
  )
}

function FileRow({
  row,
  active,
  onSelect,
  onToggleStage,
}: {
  row: Extract<TreeRow, { kind: "file" }>
  active: boolean
  onSelect: (path: string) => void
  onToggleStage: (file: GitFile) => void
}) {
  const file = row.file
  const mark = MARK[file.status]

  return (
    <div
      style={{ paddingInlineStart: 4 + row.depth * 11 }}
      className={cn(
        "group flex h-6 items-center gap-1.5 rounded pr-1 transition-colors duration-100",
        "hover:bg-raised",
        active && "bg-raised"
      )}
    >
      <StageBox
        state={file.staged ? "on" : "off"}
        label={file.staged ? `Unstage ${row.label}` : `Stage ${row.label}`}
        onToggle={() => onToggleStage(file)}
      />

      <button
        type="button"
        onClick={() => onSelect(file.path)}
        title={file.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span
          title={mark.title}
          className={cn("w-2.5 shrink-0 font-mono text-[10px] font-semibold", mark.tone)}
        >
          {mark.glyph}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11.5px]",
            active ? "text-foreground" : "text-foreground/85"
          )}
        >
          {row.label}
        </span>
        {file.insertions || file.deletions ? (
          <span className="tabular shrink-0 text-[10px]">
            <span className="text-added">+{file.insertions}</span>{" "}
            <span className="text-removed">−{file.deletions}</span>
          </span>
        ) : null}
      </button>
      <Slot name="inspector.changes.file.trailing" file={file} />
    </div>
  )
}
