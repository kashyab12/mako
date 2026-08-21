import { useMemo, useState, type ReactNode } from "react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { fuzzy } from "@/lib/fuzzy"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"

export interface SearchSelectOption {
  value: string
  label: string
  detail?: string
  keywords?: string
  icon?: ReactNode
}

export function SearchSelect({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose…",
  searchPlaceholder = "Search",
  className,
}: {
  value: string
  options: SearchSelectOption[]
  onChange: (value: string) => void
  label: string
  placeholder?: string
  searchPlaceholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlighted, setHighlighted] = useState(0)
  const selected = options.find((option) => option.value === value)
  const shown = useMemo(() => {
    const term = query.trim()
    if (!term) return options
    return options
      .flatMap((option) => {
        const match = fuzzy(
          term,
          `${option.label} ${option.value} ${option.detail ?? ""} ${option.keywords ?? ""}`
        )
        return match ? [{ option, score: match.score }] : []
      })
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.option)
  }, [options, query])
  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    setQuery("")
    setHighlighted(0)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setHighlighted(0)
        if (!next) setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "pressable flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-raised px-2 text-ui text-foreground/90 ring-1 ring-hairline",
            "hover:bg-fill-hover aria-expanded:bg-fill-selected",
            className
          )}
        >
          {selected?.icon}
          <span className="min-w-0 flex-1 truncate text-left">
            {selected?.label ?? placeholder}
          </span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="flex h-9 items-center gap-2 border-b border-hairline px-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlighted(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setHighlighted((current) =>
                  Math.min(current + 1, Math.max(0, shown.length - 1))
                )
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setHighlighted((current) => Math.max(0, current - 1))
              } else if (event.key === "Enter" && shown[highlighted]) {
                event.preventDefault()
                choose(shown[highlighted].value)
              }
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
          />
        </div>
        <div
          role="listbox"
          aria-label={label}
          className="max-h-72 overflow-y-auto overscroll-contain p-1"
        >
          {shown.map((option, index) => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(option.value)}
                className={cn(
                  "pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  active
                    ? "bg-fill-selected"
                    : index === highlighted
                      ? "bg-fill-hover"
                      : "hover:bg-fill-hover"
                )}
              >
                {option.icon}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-foreground/90">
                    {option.label}
                  </span>
                  {option.detail ? (
                    <span className="block truncate text-label text-faint">
                      {option.detail}
                    </span>
                  ) : null}
                </span>
                {active ? (
                  <CheckIcon className="size-3.5 shrink-0 text-foreground" />
                ) : null}
              </button>
            )
          })}
          {shown.length === 0 ? (
            <p className="px-2 py-6 text-center text-ui text-faint">
              No matches.
            </p>
          ) : null}
        </div>
        <div className="border-t border-hairline px-2.5 py-1.5 text-label text-faint">
          {query.trim() ? `${shown.length} of ${options.length}` : `${options.length} options`}
        </div>
      </PopoverContent>
    </Popover>
  )
}
