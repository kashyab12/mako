import { useEffect, useRef, useState } from "react"
import { IconAction } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import { formatChord } from "@/extend/commands"
import { actions, useSession } from "@/state/session"
import { togglePref, usePrefs } from "@/state/prefs"
import { workspaceName } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
  SearchIcon,
  SquareIcon,
} from "lucide-react"

/**
 * A single draggable strip. It carries the window controls' inset, the session
 * name (editable in place), and the two panel toggles — nothing that competes
 * with the transcript for attention.
 */
export function TitleBar() {
  const name = useSession((state) => state.meta?.sessionName)
  const cwd = useSession((state) => state.meta?.cwd)
  const streaming = useSession((state) => state.meta?.isStreaming ?? false)
  const railOpen = usePrefs((prefs) => prefs.railOpen)
  const inspectorOpen = usePrefs((prefs) => prefs.inspectorOpen)

  return (
    <header className="drag-region relative flex h-[38px] shrink-0 items-center gap-1 border-b border-hairline bg-surface pr-2 pl-[86px]">
      <IconAction
        label={railOpen ? "Hide sessions" : "Show sessions"}
        keys={formatChord("mod+b")}
        data-on={railOpen}
        onClick={() => togglePref("railOpen")}
      >
        <PanelLeftIcon />
      </IconAction>
      <IconAction label="New session" keys={formatChord("mod+n")} onClick={() => void actions.newSession()}>
        <PlusIcon />
      </IconAction>

      <Slot name="titlebar.leading" />

      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <div className="pointer-events-auto flex min-w-0 max-w-[46%] items-center gap-2">
          {streaming ? (
            <span className="size-1.5 shrink-0 animate-live rounded-full bg-brand" aria-label="Streaming" />
          ) : null}
          <SessionTitle name={name} fallback={workspaceName(cwd)} />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1">
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
        <IconAction
          label="Command palette"
          keys={formatChord("mod+k")}
          onClick={() => window.dispatchEvent(new CustomEvent("pi:palette"))}
        >
          <SearchIcon />
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
