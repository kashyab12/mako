import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Eyebrow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/agent-threads"
import { threadsStore, useThreads } from "@/state/threads"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon, ZapIcon } from "lucide-react"

/**
 * Who answers, and how — one panel, in the model picker's own language.
 *
 * The trigger sits where a picker belongs and reads like one: the agent's
 * mark and name. The panel puts every agent on a chip row and the selected
 * agent's real tuning below it — model rows the way the model picker draws
 * them (recently used on this machine first, a curated floor under that,
 * free-type because a list must never be a cage), effort as chips in the
 * CLI's own vocabulary, fast mode only where a harness actually has one,
 * and Devin as the cloud hand that needs no folder. Nothing here renders
 * an option its agent would ignore.
 */

interface Tuning {
  models: string[]
  efforts: string[]
  fast: boolean
}

const ORDER = ["pi", "claude", "codex", "cursor", "grok", "devin"]

export function AgentPicker() {
  const [open, setOpen] = useState(false)
  const selected = useThreads((state) => state.composerHarness)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Agent: ${harnessLabel(selected)}`}
          className={cn(
            "pressable no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2",
            "text-[12.5px] font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-raised aria-expanded:bg-raised"
          )}
        >
          <HarnessIcon harness={selected} className="size-3.5" />
          <span className="truncate">{harnessLabel(selected)}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[26rem] gap-0 p-0">
        <AgentPanel selected={selected} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function AgentPanel({ selected, onDone }: { selected: string; onDone: () => void }) {
  const [available, setAvailable] = useState<Record<string, boolean>>({ pi: true })
  const [remotes, setRemotes] = useState<string[]>([])
  const [tuning, setTuning] = useState<Tuning | null>(null)
  const chosen = useThreads((state) => state.composerTuning[selected] ?? {})

  useEffect(() => {
    if (!hasBridge()) return
    void getPi().harnessAvailability().then(setAvailable).catch(() => {})
    void getPi().resumableHarnesses().then((list) => setRemotes(list.filter((h) => h === "devin"))).catch(() => {})
  }, [])

  useEffect(() => {
    if (!hasBridge() || selected === "pi" || selected === "devin") {
      setTuning(null)
      return
    }
    setTuning(null)
    void getPi()
      .harnessTuning(selected)
      .then(setTuning)
      .catch(() => setTuning({ models: [], efforts: [], fast: false }))
  }, [selected])

  const choices = ORDER.filter(
    (harness) => available[harness] || (harness === "devin" && remotes.includes("devin"))
  )
  const devinMissing = !choices.includes("devin")

  const pick = (harness: string) => threadsStore.set({ composerHarness: harness })
  const tune = (patch: Partial<{ model?: string; effort?: string; fast?: boolean }>) => {
    const all = threadsStore.get().composerTuning
    threadsStore.set({ composerTuning: { ...all, [selected]: { ...all[selected], ...patch } } })
  }

  return (
    <div>
      <div className="border-b border-hairline p-1.5">
        <div className="flex flex-wrap gap-1">
          {choices.map((harness) => (
            <button
              key={harness}
              type="button"
              onClick={() => pick(harness)}
              className={cn(
                "pressable inline-flex h-6 items-center gap-1.5 rounded px-2 text-[11px] font-medium",
                "transition-colors duration-100",
                selected === harness
                  ? "bg-brand-soft text-brand"
                  : "bg-raised text-faint hover:text-muted-foreground"
              )}
            >
              <HarnessIcon harness={harness} className="size-3" tinted={selected === harness} />
              {harnessLabel(harness)}
            </button>
          ))}
          {devinMissing ? (
            <span
              className="inline-flex h-6 items-center gap-1.5 rounded bg-raised/50 px-2 text-[11px] text-faint/60"
              title="Add a Devin service key in Settings → Agents"
            >
              <HarnessIcon harness="devin" className="size-3" tinted={false} />
              Devin
            </span>
          ) : null}
        </div>
      </div>

      <div className="max-h-[19rem] overflow-y-auto overscroll-contain p-1">
        {selected === "pi" ? (
          <p className="px-2 py-4 text-[11.5px] leading-relaxed text-faint">
            Pi answers in this tab, streaming, steerable mid-turn. Its model and
            reasoning live in the pickers beside this one.
          </p>
        ) : selected === "devin" ? (
          <p className="px-2 py-4 text-[11.5px] leading-relaxed text-faint">
            Devin works in its own cloud from your prompt — no folder, no local
            process. The session appears in Threads as it works, and replies go
            straight to it.
          </p>
        ) : tuning === null ? (
          <p className="shimmer px-2 py-4 text-[11.5px]">Reading what {harnessLabel(selected)} offers…</p>
        ) : (
          <ForeignTuningBody
            harness={selected}
            tuning={tuning}
            chosen={chosen}
            onTune={tune}
            onDone={onDone}
          />
        )}
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-2 py-1.5 text-[10.5px] text-faint">
        <span>
          {selected === "pi"
            ? "Native to this tab"
            : selected === "devin"
              ? "Runs in Devin's cloud"
              : selected === "claude" || selected === "cursor"
                ? "Runs live in this workspace"
                : "Runs in this workspace, streaming in"}
        </span>
        <span>Every conversation lands in Threads</span>
      </div>
    </div>
  )
}

function ForeignTuningBody({
  harness,
  tuning,
  chosen,
  onTune,
  onDone,
}: {
  harness: string
  tuning: Tuning
  chosen: { model?: string; effort?: string; fast?: boolean }
  onTune: (patch: Partial<{ model?: string; effort?: string; fast?: boolean }>) => void
  onDone: () => void
}) {
  const [typed, setTyped] = useState("")

  return (
    <div>
      <Eyebrow className="px-1.5 pt-1.5 pb-1">Model</Eyebrow>
      <ModelRow
        label="Harness default"
        detail={`whatever ${harnessLabel(harness)} would pick itself`}
        selected={!chosen.model}
        onChoose={() => onTune({ model: undefined })}
      />
      {tuning.models.map((model, index) => (
        <ModelRow
          key={model}
          mono
          label={model}
          detail={index < 3 ? "seen on this machine" : undefined}
          selected={chosen.model === model}
          onChoose={() => onTune({ model })}
        />
      ))}
      <div className="px-1.5 pt-1">
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && typed.trim()) {
              onTune({ model: typed.trim() })
              setTyped("")
              onDone()
            }
          }}
          placeholder="Any model id — Enter to use it"
          className="h-7 w-full rounded-md bg-raised px-2 font-mono text-[11.5px] placeholder:font-sans placeholder:text-faint focus:outline-none"
        />
      </div>

      {tuning.efforts.length > 0 ? (
        <>
          <Eyebrow className="px-1.5 pt-3 pb-1">Reasoning effort</Eyebrow>
          <div className="flex flex-wrap gap-1 px-1.5 pb-1">
            <EffortChip
              label="default"
              active={!chosen.effort}
              onClick={() => onTune({ effort: undefined })}
            />
            {tuning.efforts.map((effort) => (
              <EffortChip
                key={effort}
                label={effort}
                active={chosen.effort === effort}
                onClick={() => onTune({ effort })}
              />
            ))}
          </div>
        </>
      ) : null}

      {tuning.fast ? (
        <>
          <Eyebrow className="px-1.5 pt-3 pb-1">Mode</Eyebrow>
          <button
            type="button"
            onClick={() => onTune({ fast: chosen.fast ? undefined : true })}
            className={cn(
              "mx-1.5 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100",
              chosen.fast ? "bg-raised" : "hover:bg-raised/60"
            )}
          >
            <ZapIcon className={cn("size-3.5", chosen.fast ? "fill-caution text-caution" : "text-faint")} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-foreground/90">Fast mode</span>
              <span className="block text-[10.5px] text-faint">
                Quicker answers, lighter reasoning
              </span>
            </span>
            {chosen.fast ? <CheckIcon className="size-3.5 text-brand" /> : null}
          </button>
        </>
      ) : null}
    </div>
  )
}

function ModelRow({
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
        {detail ? (
          <span className="mt-0.5 block text-[10.5px] text-faint">{detail}</span>
        ) : null}
      </span>
      {selected ? <CheckIcon className="size-3.5 shrink-0 text-brand" /> : null}
    </button>
  )
}

function EffortChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "pressable inline-flex h-5 items-center rounded px-1.5 text-[10.5px] font-medium transition-colors duration-100",
        active ? "bg-brand-soft text-brand" : "bg-raised text-faint hover:text-muted-foreground"
      )}
    >
      {label}
    </button>
  )
}
