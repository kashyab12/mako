import { useEffect, useRef, useState } from "react"
import { IconAction } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import { formatChord } from "@/extend/commands"
import { actions, useSession } from "@/state/session"
import { togglePref, usePrefs } from "@/state/prefs"
import { MakoMark } from "@/components/ui/mako-mark"
import { workspaceName } from "@/lib/format"
import { search } from "@/state/search"
import { cn } from "@/lib/utils"
import {
  ChevronsUpDownIcon,
  FolderIcon,
  PanelLeftIcon,
  PanelRightIcon,
  CommandIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareIcon,
} from "lucide-react"

/**
 * The title strip.
 *
 * Its left segment *is* the sidebar's header — same width, same right border,
 * so the two read as one column rather than as two stacked bars each with
 * their own "new session" button. That duplication was the whole reason the
 * chrome looked wrong: a window has one header, not one per panel.
 *
 * When the rail is closed the segment collapses to just the toggle and the
 * traffic-light inset, and the title recentres over the full width.
 */
export function TitleBar() {
  const name = useSession((state) => state.meta?.sessionName)
  const cwd = useSession((state) => state.meta?.cwd)
  const streaming = useSession((state) => state.meta?.isStreaming ?? false)
  const railOpen = usePrefs((prefs) => prefs.railOpen)
  const railWidth = usePrefs((prefs) => prefs.railWidth)
  const inspectorOpen = usePrefs((prefs) => prefs.inspectorOpen)

  return (
    <header className="drag-region relative flex h-[38px] shrink-0 items-center border-b border-hairline bg-surface pr-2">
      <div
        style={railOpen ? { width: railWidth } : undefined}
        className={cn(
          "flex h-full shrink-0 items-center gap-1 pr-2 pl-[86px]",
          railOpen && "border-r border-hairline"
        )}
      >
        <IconAction
          label={railOpen ? "Hide sessions" : "Show sessions"}
          keys={formatChord("mod+b")}
          data-on={railOpen}
          onClick={() => togglePref("railOpen")}
        >
          <PanelLeftIcon />
        </IconAction>

        {railOpen ? (
          <>
            <WorkspaceButton cwd={cwd} />
            <IconAction
              label="New session"
              keys={formatChord("mod+n")}
              onClick={() => void actions.newSession()}
            >
              <PlusIcon />
            </IconAction>
          </>
        ) : (
          <IconAction
            label="New session"
            keys={formatChord("mod+n")}
            onClick={() => void actions.newSession()}
          >
            <PlusIcon />
          </IconAction>
        )}

        <Slot name="titlebar.leading" />
      </div>

      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <div className="pointer-events-auto flex min-w-0 max-w-[46%] items-center gap-2">
          <MakoMark className="size-3.5 text-foreground/60" />
          {streaming ? (
            <span className="size-1.5 shrink-0 animate-live rounded-full bg-brand" aria-label="Streaming" />
          ) : null}
          <SessionTitle name={name} fallback={workspaceName(cwd)} />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1 pl-2">
        <Slot name="titlebar.trailing" />
        {streaming ? (
          <IconAction
            label="Stop"
            keys={formatChord("mod+escape")}
            tone="danger"
            onClick={() => void actions.abort()}
          >
            <SquareIcon />
          </IconAction>
        ) : null}
        {/* A magnifier searches; it does not list commands. Once there was a
            real search these two had to stop sharing an icon. */}
        <IconAction
          label="Search this project"
          keys={formatChord("mod+shift+f")}
          onClick={() => search.open()}
        >
          <SearchIcon />
        </IconAction>
        <IconAction
          label="Command palette"
          keys={formatChord("mod+k")}
          onClick={() => window.dispatchEvent(new CustomEvent("pi:palette"))}
        >
          <CommandIcon />
        </IconAction>
        <IconAction
          label="Settings"
          keys={formatChord("mod+,")}
          onClick={() => window.dispatchEvent(new CustomEvent("pi:settings"))}
        >
          <SettingsIcon />
        </IconAction>
        <IconAction
          label={inspectorOpen ? "Hide inspector" : "Show inspector"}
          keys={formatChord("mod+i")}
          data-on={inspectorOpen}
          onClick={() => togglePref("inspectorOpen")}
        >
          <PanelRightIcon />
        </IconAction>
      </div>
    </header>
  )
}

/** The folder the agent is pointed at, and the control for changing it. */
function WorkspaceButton({ cwd }: { cwd?: string }) {
  return (
    <button
      type="button"
      onClick={() => void actions.pickWorkspace()}
      title={`${cwd ?? ""}\nOpen a different folder`}
      className={cn(
        "no-drag pressable group flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5",
        "transition-colors duration-100 hover:bg-raised"
      )}
    >
      <FolderIcon className="size-3.5 shrink-0 text-faint" />
      <span className="truncate text-[12.5px] font-semibold">{workspaceName(cwd)}</span>
      <ChevronsUpDownIcon className="size-3 shrink-0 text-faint opacity-0 transition-opacity duration-120 group-hover:opacity-100" />
    </button>
  )
}

function SessionTitle({ name, fallback }: { name?: string; fallback: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name ?? "")
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])

  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setEditing(false)
          const next = draft.trim()
          if (next && next !== name) void actions.rename(next)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
          if (event.key === "Escape") {
            setDraft(name ?? "")
            setEditing(false)
          }
        }}
        className="no-drag h-6 w-56 rounded-md bg-raised px-2 text-center text-[12.5px] font-medium outline-none ring-1 ring-brand/40"
      />
    )
  }

  return (
    <button
      type="button"
      title="Rename session"
      onClick={() => {
        setDraft(name ?? "")
        setEditing(true)
      }}
      className={cn(
        "no-drag truncate rounded-md px-2 py-0.5 text-[12.5px] font-medium transition-colors duration-100 hover:bg-raised",
        name ? "text-foreground" : "text-faint"
      )}
    >
      {name || fallback}
    </button>
  )
}
