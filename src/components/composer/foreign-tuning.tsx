import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { threadsStore, useThreads } from "@/state/threads"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { BarChart3Icon, CheckIcon, ChevronDownIcon, ZapIcon } from "lucide-react"

/**
 * A foreign harness's own tuning, in the composer.
 *
 * Everything here is real: the model list is what this machine has actually
 * run on that harness (from the catalog, most recent first) over a curated
 * floor, with a free-type row because a list must never be a cage; the
 * effort levels are the CLI's own vocabulary passed to its own flag; and
 * fast mode appears only for Cursor, which is the harness that has one.
 * Nothing renders that the CLI would ignore.
 */

interface Tuning {
  models: string[]
  efforts: string[]
  fast: boolean
}

export function ForeignTuning({ harness }: { harness: string }) {
  const [tuning, setTuning] = useState<Tuning | null>(null)
  const chosen = useThreads((state) => state.composerTuning[harness] ?? {})

  useEffect(() => {
    if (!hasBridge()) return
    setTuning(null)
    void getPi()
      .harnessTuning(harness)
      .then(setTuning)
      .catch(() => setTuning({ models: [], efforts: [], fast: false }))
  }, [harness])

  if (!tuning) return null

  const set = (patch: Partial<{ model?: string; effort?: string; fast?: boolean }>) => {
    const all = threadsStore.get().composerTuning
    threadsStore.set({ composerTuning: { ...all, [harness]: { ...all[harness], ...patch } } })
  }

  return (
    <>
      {tuning.models.length > 0 ? (
        <ModelMenu
          models={tuning.models}
          chosen={chosen.model}
          onPick={(model) => set({ model })}
        />
      ) : null}
      {tuning.efforts.length > 0 ? (
        <EffortMenu
          efforts={tuning.efforts}
          chosen={chosen.effort}
          onPick={(effort) => set({ effort })}
        />
      ) : null}
      {tuning.fast ? (
        <button
          type="button"
          title="Fast mode — quicker answers, lighter reasoning"
          onClick={() => set({ fast: chosen.fast ? undefined : true })}
          className={cn(
            "pressable flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors duration-150",
            chosen.fast ? "bg-raised text-foreground" : "text-faint hover:text-muted-foreground"
          )}
        >
          <ZapIcon className={cn("size-3", chosen.fast && "fill-current")} />
          fast
        </button>
      ) : null}
    </>
  )
}

function ModelMenu({
  models,
  chosen,
  onPick,
}: {
  models: string[]
  chosen?: string
  onPick: (model?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Model"
          className={cn(
            "pressable flex h-7 max-w-44 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors duration-150",
            chosen ? "bg-raised text-foreground" : "text-faint hover:text-muted-foreground"
          )}
        >
          <span className="min-w-0 truncate">{chosen ?? "model: default"}</span>
          <ChevronDownIcon className="size-2.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-64 p-1">
        <p className="px-2 pt-1 pb-1.5 text-[10.5px] text-faint">
          Models this machine has run, then the usual suspects
        </p>
        <button
          type="button"
          onClick={() => {
            onPick(undefined)
            setOpen(false)
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/90 transition-colors hover:bg-raised"
        >
          <span className="min-w-0 flex-1">Harness default</span>
          {!chosen ? <CheckIcon className="size-3 text-foreground/70" /> : null}
        </button>
        {models.map((model) => (
          <button
            key={model}
            type="button"
            onClick={() => {
              onPick(model)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11.5px] text-foreground/90 transition-colors hover:bg-raised"
          >
            <span className="min-w-0 flex-1 truncate">{model}</span>
            {chosen === model ? <CheckIcon className="size-3 text-foreground/70" /> : null}
          </button>
        ))}
        <div className="mt-1 border-t border-hairline pt-1">
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && typed.trim()) {
                onPick(typed.trim())
                setTyped("")
                setOpen(false)
              }
            }}
            placeholder="or type any model id…"
            className="h-7 w-full rounded bg-surface px-2 font-mono text-[11px] text-foreground placeholder:text-faint focus:ring-1 focus:ring-hairline focus:outline-none"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function EffortMenu({
  efforts,
  chosen,
  onPick,
}: {
  efforts: string[]
  chosen?: string
  onPick: (effort?: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Reasoning effort"
          className={cn(
            "pressable flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] transition-colors duration-150",
            chosen ? "bg-raised text-foreground" : "text-faint hover:text-muted-foreground"
          )}
        >
          <BarChart3Icon className="size-3" />
          {chosen ?? "effort"}
          <ChevronDownIcon className="size-2.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-44 p-1">
        <button
          type="button"
          onClick={() => {
            onPick(undefined)
            setOpen(false)
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/90 transition-colors hover:bg-raised"
        >
          <span className="min-w-0 flex-1">Default</span>
          {!chosen ? <CheckIcon className="size-3 text-foreground/70" /> : null}
        </button>
        {efforts.map((effort) => (
          <button
            key={effort}
            type="button"
            onClick={() => {
              onPick(effort)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/90 transition-colors hover:bg-raised"
          >
            <span className="min-w-0 flex-1">{effort}</span>
            {chosen === effort ? <CheckIcon className="size-3 text-foreground/70" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
