import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { harnessDefault, rememberHarnessDefault, setComposerTuning, useThreads } from "@/state/threads"
import { decomposeModelId } from "@/lib/model-id"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { CheckIcon, ZapIcon } from "lucide-react"

/**
 * The reasoning gauge, for every harness.
 *
 * Pi's effort picker got this right — a four-bar gauge you can read without
 * reading a word, levels with one honest sentence each — so foreign
 * harnesses get the same control, not a row of chips in a panel. The levels
 * are each CLI's own vocabulary; the gauge scales across however many a
 * harness has. Fast mode lives here too, where speed belongs: a lightning
 * state on the same gauge, gently alive while it is on.
 */

const DESCRIPTIONS: Record<string, string> = {
  minimal: "A brief look before answering.",
  low: "Light reasoning for routine work.",
  medium: "Balanced. A good default for real tasks.",
  high: "Deliberate. For tricky bugs and design work.",
  xhigh: "Extended reasoning. Slow and expensive.",
  max: "Everything the model has. Reserve for hard problems.",
}

interface Tuning {
  efforts: string[]
  fast: boolean
  defaultEffort?: string
}

export function ForeignEffortPicker({ harness }: { harness: string }) {
  const [open, setOpen] = useState(false)
  const [tuning, setTuning] = useState<Tuning | null>(null)
  const chosen = useThreads((state) => state.composerTuning[harness] ?? {})

  useEffect(() => {
    if (!hasBridge()) return
    setTuning(null)
    void getPi()
      .harnessTuning(harness)
      .then((next) => {
        setTuning({ efforts: next.efforts, fast: next.fast, defaultEffort: next.defaultEffort })
        rememberHarnessDefault(harness, {
          model: next.defaultModel || undefined,
          effort: next.defaultEffort,
        })
      })
      .catch(() =>
        setTuning({ efforts: [], fast: false, defaultEffort: harnessDefault(harness).effort })
      )
  }, [harness])

  if (!tuning || (tuning.efforts.length === 0 && !tuning.fast)) return null

  const set = (patch: Partial<{ effort?: string; fast?: boolean }>) =>
    setComposerTuning(harness, patch)

  const defaults = harnessDefault(harness)
  const encoded = defaults.model ? decomposeModelId(harness, defaults.model) : undefined
  const fallbackEffort = tuning?.defaultEffort ?? defaults.effort ?? encoded?.effort
  const fallbackFast = encoded?.fast ?? false
  const fastOn = chosen.fast ?? fallbackFast
  const label = fastOn ? "fast" : (chosen.effort ?? fallbackEffort ?? "effort")

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Reasoning effort: ${label}`}
          className={cn(
            "pressable no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-raised aria-expanded:bg-raised",
            chosen.effort || chosen.fast ? "text-foreground/85" : "text-faint"
          )}
        >
          {(chosen.fast ?? fallbackFast) ? (
            <ZapIcon className="size-3 animate-[fast-alive_1.6s_ease-in-out_infinite] fill-caution text-caution" />
          ) : (
            <Gauge filled={rankOf(chosen.effort ?? fallbackEffort, tuning.efforts)} />
          )}
          <span className="capitalize">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[17rem] gap-0 p-1">
        {tuning.fast ? (
          <button
            type="button"
            onClick={() => {
              set({ fast: chosen.fast ? undefined : true, effort: undefined })
              setOpen(false)
            }}
            className={cn(
              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100 hover:bg-raised",
              chosen.fast && "bg-raised"
            )}
          >
            <ZapIcon
              className={cn(
                "mt-[3px] size-3 shrink-0",
                chosen.fast ? "fill-caution text-caution" : "text-faint"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium">Fast mode</span>
              <span className="block text-[11px] leading-snug text-faint">
                Quicker answers, lighter reasoning. Off is the thorough one.
              </span>
            </span>
            {chosen.fast ? <CheckIcon className="mt-1 size-3.5 shrink-0 text-brand" /> : null}
          </button>
        ) : null}

        {tuning.efforts.map((effort) => {
          const isConfigDefault = effort === fallbackEffort
          const active = chosen.effort === effort || (!chosen.effort && !chosen.fast && isConfigDefault)
          return (
            <button
              key={effort}
              type="button"
              onClick={() => {
                set({ effort, fast: undefined })
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100 hover:bg-raised",
                active && "bg-raised"
              )}
            >
              <Gauge filled={rankOf(effort, tuning.efforts)} className="mt-[3px]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium capitalize">
                  {effort}
                  {isConfigDefault ? (
                    <span className="ml-1.5 text-[10px] font-normal text-faint">config default</span>
                  ) : null}
                </span>
                <span className="block text-[11px] leading-snug text-faint">
                  {DESCRIPTIONS[effort] ?? "This harness's own level."}
                </span>
              </span>
              {active ? <CheckIcon className="mt-1 size-3.5 shrink-0 text-brand" /> : null}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
    {tuning.fast ? (
      <button
        type="button"
        aria-label={fastOn ? "Fast mode on" : "Fast mode off"}
        title={fastOn ? "Fast mode — quicker, lighter reasoning. Click for thorough." : "Fast mode off. Click for quicker answers."}
        onClick={() => set({ fast: fastOn ? false : true, ...(fastOn ? {} : { effort: undefined }) })}
        className={cn(
          "pressable no-drag flex h-7 items-center rounded-md px-1.5",
          "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
          "hover:bg-raised",
          fastOn ? "text-caution" : "text-faint hover:text-foreground"
        )}
      >
        <ZapIcon
          className={cn(
            "size-3.5",
            fastOn && "animate-[fast-alive_1.6s_ease-in-out_infinite] fill-caution"
          )}
        />
      </button>
    ) : null}
    </>
  )
}

/** The chosen level's position, scaled onto four bars. */
function rankOf(effort: string | undefined, efforts: string[]): number {
  if (!effort) return 0
  const at = efforts.indexOf(effort)
  if (at === -1) return 0
  return Math.max(1, Math.round(((at + 1) / efforts.length) * 4))
}

function Gauge({ filled, className }: { filled: number; className?: string }) {
  return (
    <span className={cn("flex items-end gap-[1.5px]", className)} aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          className={cn(
            "w-[2px] rounded-[1px] transition-colors duration-150",
            index < filled ? "bg-brand" : "bg-foreground/20"
          )}
          style={{ height: 4 + index * 2 }}
        />
      ))}
    </span>
  )
}
