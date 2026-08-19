import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { setComposerTuning, useThreads } from "@/state/threads"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import type { HarnessModelOption, HarnessProfile } from "@/lib/types"
import { CheckIcon, SlidersHorizontalIcon, ZapIcon } from "lucide-react"

export function ForeignEffortPicker({ harness }: { harness: string }) {
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState<HarnessProfile | null>(null)
  const chosen = useThreads((state) => state.composerTuning[harness] ?? {})

  useEffect(() => {
    if (!hasBridge()) return
    setProfile(null)
    void getPi().harnessTuning(harness).then(setProfile).catch(() => {})
  }, [harness])

  const modelId = chosen.model ?? profile?.defaultModel
  const model = profile?.models.find((entry) => entry.id === modelId) ?? profile?.models[0]
  const options = model?.options ?? []
  if (options.length === 0) return null

  const selected = chosen.options ?? {}
  const effort = options.find(
    (option) => option.kind === "select" && /effort|reason/i.test(`${option.id} ${option.label}`)
  )
  const fast = options.find(
    (option) => option.kind === "boolean" && /fast|speed/i.test(`${option.id} ${option.label}`)
  )
  const effortValue = effort?.kind === "select"
    ? String(selected[effort.id] ?? chosen.effort ?? effort.current ?? effort.values.find((value) => value.default)?.value ?? "")
    : ""
  const fastOn = fast?.kind === "boolean" ? Boolean(selected[fast.id] ?? chosen.fast ?? fast.current) : false

  const setOption = (option: HarnessModelOption, value: string | boolean) => {
    const next = { ...selected, [option.id]: value }
    setComposerTuning(harness, {
      options: next,
      ...(option === effort && typeof value === "string" ? { effort: value } : {}),
      ...(option === fast && typeof value === "boolean" ? { fast: value } : {}),
    })
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Model options"
            className={cn(
              "pressable no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium",
              "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
              "text-faint hover:bg-raised hover:text-foreground aria-expanded:bg-raised"
            )}
          >
            {fastOn ? (
              <ZapIcon className="size-3 fill-caution text-caution" />
            ) : effort?.kind === "select" ? (
              <Gauge filled={rankOf(effortValue, effort.values.map((value) => value.value))} />
            ) : (
              <SlidersHorizontalIcon className="size-3" />
            )}
            <span className="capitalize">{fastOn ? "fast" : effortValue || "options"}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" sideOffset={8} className="max-h-[24rem] w-[19rem] overflow-y-auto p-1">
          {options.map((option) => (
            <OptionSection
              key={option.id}
              option={option}
              value={selected[option.id] ?? option.current}
              onChange={(value) => setOption(option, value)}
            />
          ))}
        </PopoverContent>
      </Popover>
      {fast?.kind === "boolean" ? (
        <button
          type="button"
          aria-label={fastOn ? "Fast mode on" : "Fast mode off"}
          title={fastOn ? "Fast mode on" : "Fast mode off"}
          onClick={() => setOption(fast, !fastOn)}
          className={cn(
            "pressable no-drag flex h-7 items-center rounded-md px-1.5 hover:bg-raised",
            fastOn ? "text-caution" : "text-faint hover:text-foreground"
          )}
        >
          <ZapIcon className={cn("size-3.5", fastOn && "fill-caution")} />
        </button>
      ) : null}
    </>
  )
}

function OptionSection({
  option,
  value,
  onChange,
}: {
  option: HarnessModelOption
  value: string | boolean | undefined
  onChange: (value: string | boolean) => void
}) {
  if (option.kind === "boolean") {
    const active = typeof value === "boolean" ? value : option.current
    return (
      <button
        type="button"
        onClick={() => onChange(!active)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12.5px] hover:bg-raised",
          active && "bg-raised"
        )}
      >
        <span className="flex-1">{option.label}</span>
        {active ? <CheckIcon className="size-3.5 text-brand" /> : null}
      </button>
    )
  }

  const current = typeof value === "string" ? value : option.current ?? option.values.find((entry) => entry.default)?.value
  return (
    <section className="pb-1">
      <p className="px-2 pt-1.5 pb-1 text-[10.5px] font-medium text-faint">{option.label}</p>
      {option.values.map((entry) => {
        const active = current === entry.value
        return (
          <button
            key={entry.value}
            type="button"
            onClick={() => onChange(entry.value)}
            className={cn(
              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raised",
              active && "bg-raised"
            )}
          >
            {/effort|reason/i.test(`${option.id} ${option.label}`) ? (
              <Gauge filled={rankOf(entry.value, option.values.map((value) => value.value))} className="mt-[3px]" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px]">{entry.label}</span>
              {entry.description ? <span className="block text-[10.5px] leading-snug text-faint">{entry.description}</span> : null}
            </span>
            {active ? <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-brand" /> : null}
          </button>
        )
      })}
    </section>
  )
}

function rankOf(value: string, values: string[]): number {
  const at = values.indexOf(value)
  return at < 0 ? 0 : Math.max(1, Math.round(((at + 1) / values.length) * 4))
}

function Gauge({ filled, className }: { filled: number; className?: string }) {
  return (
    <span className={cn("flex items-end gap-[1.5px]", className)} aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          className={cn("w-[2px] rounded-[1px]", index < filled ? "bg-brand" : "bg-foreground/20")}
          style={{ height: 4 + index * 2 }}
        />
      ))}
    </span>
  )
}
