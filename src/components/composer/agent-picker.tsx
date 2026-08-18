import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/agent-threads"
import { threadsStore, useThreads } from "@/state/threads"
import { actions, store as sessionStore } from "@/state/session"
import { toast } from "sonner"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { ChevronDownIcon } from "lucide-react"

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
  const hasDevinModels = sessionStore.get().models.some((model) => model.provider === "devin")


  useEffect(() => {
    if (!hasBridge()) return
    void getPi().harnessAvailability().then(setAvailable).catch(() => {})
  }, [])


  const choices = ORDER.filter(
    (harness) => available[harness] || (harness === "devin" && hasDevinModels)
  )
  const devinMissing = !choices.includes("devin")

  const pick = (harness: string) => {
    // Devin means one thing here: Devin's models answering locally through
    // Pi — streaming, steerable, in this folder. Picking it selects a devin
    // model in Pi's own picker and gets out of the way.
    if (harness === "devin") {
      const models = sessionStore.get().models
      const current = sessionStore.get().meta?.model
      const devinModels = models.filter((model) => model.provider === "devin")
      if (devinModels.length === 0) {
        toast.error("No Devin models in Pi's list", {
          description: "The pi-devin provider supplies them — check it is installed and signed in.",
        })
        return
      }
      threadsStore.set({ composerHarness: "pi" })
      if (current?.provider !== "devin") {
        const first = devinModels[0]
        if (first) void actions.setModel(first.provider, first.id)
      }
      onDone()
      return
    }
    threadsStore.set({ composerHarness: harness })
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
              title="Devin's models arrive through the pi-devin provider — install and sign in, and this lights up"
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
        ) : (
          <p className="px-2 py-4 text-[11.5px] leading-relaxed text-faint">
            {harnessLabel(selected)} answers in this workspace, its conversation
            right here. Model and reasoning live in the pickers beside this one
            — the same seats Pi uses.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-2 py-1.5 text-[10.5px] text-faint">
        <span>
          {selected === "pi"
            ? "Native to this tab"
            : selected === "claude" || selected === "cursor"
              ? "Runs live in this workspace"
              : "Runs in this workspace, streaming in"}
        </span>
        <span>Every conversation lands in Threads</span>
      </div>
    </div>
  )
}



