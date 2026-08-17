import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Eyebrow } from "@/components/ui/kit"
import { actions } from "@/state/session"
import {
  prefsStore,
  setPref,
  usePrefs,
  type RailGroupBy,
  type RailScope,
  type RailSortBy,
} from "@/state/prefs"
import { cn } from "@/lib/utils"
import { CheckIcon, SlidersHorizontalIcon } from "lucide-react"

/**
 * How the rail is scoped and grouped.
 *
 * These live behind one button rather than as always-visible switches: they
 * are set rarely and read never, so spending a row of the rail on them takes
 * space from the list they exist to organise. The trigger carries a dot when
 * the settings are off their defaults, which is the only signal needed at
 * rest.
 */

const SCOPES: Array<{ value: RailScope; label: string; hint: string }> = [
  { value: "workspace", label: "This project", hint: "Sessions in the current folder" },
  { value: "all", label: "All projects", hint: "Everywhere Pi has run" },
]

const GROUPS: Array<{ value: RailGroupBy; label: string; hint: string }> = [
  { value: "date", label: "Date", hint: "Today, this week, earlier" },
  { value: "project", label: "Project", hint: "One group per folder" },
  { value: "none", label: "Nothing", hint: "One flat list" },
]

const SORTS: Array<{ value: RailSortBy; label: string; hint: string }> = [
  { value: "recent", label: "Last used", hint: "Most recently touched first" },
  { value: "name", label: "Name", hint: "Alphabetical" },
  { value: "size", label: "Length", hint: "Longest conversations first" },
]

export function RailOptions() {
  const [open, setOpen] = useState(false)
  const scope = usePrefs((prefs) => prefs.railScope)
  const groupBy = usePrefs((prefs) => prefs.railGroupBy)
  const sortBy = usePrefs((prefs) => prefs.railSortBy)
  const modified = scope !== "workspace" || groupBy !== "date" || sortBy !== "recent"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Sort and group sessions"
          title="Sort and group sessions"
          className={cn(
            "pressable no-drag relative flex size-7 shrink-0 items-center justify-center rounded-md",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease,color_120ms_ease]",
            "hover:bg-raised aria-expanded:bg-raised",
            modified ? "text-foreground/80" : "text-faint hover:text-foreground"
          )}
        >
          <SlidersHorizontalIcon className="size-3.5" />
          {modified ? (
            <span className="absolute top-1 right-1 size-1 rounded-full bg-foreground/70" />
          ) : null}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={6} className="w-60 gap-0 p-1">
        <Eyebrow className="px-2 pt-1.5 pb-1">Show</Eyebrow>
        {SCOPES.map((option) => (
          <Row
            key={option.value}
            label={option.label}
            hint={option.hint}
            selected={scope === option.value}
            onSelect={() => {
              setPref("railScope", option.value)
              void actions.refreshSessions(undefined, option.value)
              setOpen(false)
            }}
          />
        ))}

        <div className="my-1 h-px bg-hairline" />

        <Eyebrow className="px-2 pt-1 pb-1">Sort by</Eyebrow>
        {SORTS.map((option) => (
          <Row
            key={option.value}
            label={option.label}
            hint={option.hint}
            selected={sortBy === option.value}
            onSelect={() => {
              setPref("railSortBy", option.value)
              setOpen(false)
            }}
          />
        ))}

        <div className="my-1 h-px bg-hairline" />

        <Eyebrow className="px-2 pt-1 pb-1">Group by</Eyebrow>
        {GROUPS.map((option) => (
          <Row
            key={option.value}
            label={option.label}
            hint={option.hint}
            selected={groupBy === option.value}
            onSelect={() => {
              setPref("railGroupBy", option.value)
              setOpen(false)
            }}
          />
        ))}

        {prefsStore.get().collapsedGroups.length > 0 ? (
          <>
            <div className="my-1 h-px bg-hairline" />
            <button
              type="button"
              onClick={() => {
                setPref("collapsedGroups", [])
                setOpen(false)
              }}
              className="w-full rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors duration-100 hover:bg-raised hover:text-foreground"
            >
              Expand all groups
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function Row({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string
  hint: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100 hover:bg-raised"
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[12.5px]",
            selected ? "font-medium text-foreground" : "text-foreground/85"
          )}
        >
          {label}
        </span>
        <span className="block truncate text-[10.5px] text-faint">{hint}</span>
      </span>
      {selected ? <CheckIcon className="size-3.5 shrink-0 text-foreground/70" /> : null}
    </button>
  )
}
