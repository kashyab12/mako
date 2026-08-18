import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Eyebrow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/agent-threads"
import { threadsStore, useThreads } from "@/state/threads"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

/**
 * The model picker, for harnesses that are not Pi.
 *
 * Same seat, same anatomy, same gestures as Pi's: a trigger wearing the
 * mark and the model's name, a panel of rows with a check on the current
 * one. The list is what this machine has actually run on that harness
 * (most recent first) over a curated floor, and free-type sits at the
 * bottom because a list must never be a cage. The toolbar reads the same
 * whoever answers — that is the entire point.
 */
export function ForeignModelPicker({ harness }: { harness: string }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [fallback, setFallback] = useState("")
  const [typed, setTyped] = useState("")
  const chosen = useThreads((state) => state.composerTuning[harness]?.model)

  useEffect(() => {
    if (!hasBridge()) return
    setModels([])
    setFallback("")
    void getPi()
      .harnessTuning(harness)
      .then((tuning) => {
        setFallback(tuning.defaultModel)
        setModels(tuning.models.filter((model) => model !== tuning.defaultModel))
      })
      .catch(() => setModels([]))
  }, [harness])

  const set = (model?: string) => {
    const all = threadsStore.get().composerTuning
    threadsStore.set({ composerTuning: { ...all, [harness]: { ...all[harness], model } } })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${chosen ?? (fallback ? `${fallback} (default)` : "harness default")}`}
          className={cn(
            "pressable no-drag flex h-7 min-w-0 max-w-[15rem] items-center gap-1.5 rounded-md px-2",
            "text-[12.5px] font-medium",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-raised aria-expanded:bg-raised",
            chosen ? "text-foreground/85" : "text-faint"
          )}
        >
          <HarnessIcon harness={harness} className="size-3.5" />
          <span className="truncate font-mono text-[11.5px]">{chosen ?? (fallback || "model")}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[22rem] gap-0 p-0">
        <div className="max-h-[19rem] overflow-y-auto overscroll-contain p-1">
          <Eyebrow className="px-1.5 pt-1.5 pb-1">{harnessLabel(harness)}</Eyebrow>
          <Row
            mono
            label={fallback || "Harness default"}
            detail={`${harnessLabel(harness)}'s default — used unless you say otherwise`}
            selected={!chosen}
            onChoose={() => {
              set(undefined)
              setOpen(false)
            }}
          />
          {models.map((model, index) => (
            <Row
              key={model}
              mono
              label={model}
              detail={index < 3 ? "seen on this machine" : undefined}
              selected={chosen === model}
              onChoose={() => {
                set(model)
                setOpen(false)
              }}
            />
          ))}
          <div className="px-1.5 pt-1 pb-0.5">
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && typed.trim()) {
                  set(typed.trim())
                  setTyped("")
                  setOpen(false)
                }
              }}
              placeholder="Any model id — Enter to use it"
              className="h-7 w-full rounded-md bg-raised px-2 font-mono text-[11.5px] placeholder:font-sans placeholder:text-faint focus:outline-none"
            />
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-hairline px-2 py-1.5 text-[10.5px] text-faint">
          <span>Passed to the CLI's own model flag</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Row({
  label,
  detail,
  mono,
  selected,
  onChoose,
}: {
  label: string
  detail?: string
  mono?: boolean
  selected: boolean
  onChoose: () => void
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100",
        selected ? "bg-raised" : "hover:bg-raised/60"
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[12.5px]",
            mono && "font-mono text-[11.5px]",
            selected ? "font-medium text-foreground" : "text-foreground/90"
          )}
        >
          {label}
        </span>
        {detail ? <span className="mt-0.5 block text-[10.5px] text-faint">{detail}</span> : null}
      </span>
      {selected ? <CheckIcon className="size-3.5 shrink-0 text-brand" /> : null}
    </button>
  )
}
