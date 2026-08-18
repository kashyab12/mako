import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/agent-threads"
import { threadsStore, useThreads } from "@/state/threads"
import { actions, store as sessionStore, useSession } from "@/state/session"
import { toast } from "sonner"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

/**
 * Who answers. One question, one panel.
 *
 * Each agent is a full row: its mark in a tile, its name, and the model it
 * would use right now — Pi's row shows the model actually selected, the
 * others show their harness's own default until the model picker beside
 * this one says otherwise. No chips, no filler prose: the rows themselves
 * are the information. Devin is a row too, and picking it means Devin's
 * models answering locally through Pi — it flips the selection and gets
 * out of the way.
 */

const ORDER = ["pi", "claude", "codex", "cursor", "grok", "devin"]

const HOW: Record<string, string> = {
  pi: "Native to this tab",
  claude: "Live in this workspace",
  cursor: "Live in this workspace",
  codex: "Streams into Threads",
  grok: "Streams into Threads",
  devin: "Devin's models, through Pi",
}

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
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[19rem] gap-0 p-1">
        <AgentPanel selected={selected} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function AgentPanel({ selected, onDone }: { selected: string; onDone: () => void }) {
  const [available, setAvailable] = useState<Record<string, boolean>>({ pi: true })
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const piModel = useSession((state) => state.meta?.model)
  const tuning = useThreads((state) => state.composerTuning)
  const hasDevinModels = sessionStore.get().models.some((model) => model.provider === "devin")
  const devinModel = sessionStore.get().models.find((model) => model.provider === "devin")

  useEffect(() => {
    if (!hasBridge()) return
    void getPi()
      .harnessAvailability()
      .then((next) => {
        setAvailable(next)
        // Each harness's own default model, so every row can wear one.
        for (const harness of Object.keys(next)) {
          if (!next[harness] || harness === "pi") continue
          void getPi()
            .harnessTuning(harness)
            .then((t) =>
              setDefaults((prev) => (t.defaultModel ? { ...prev, [harness]: t.defaultModel } : prev))
            )
            .catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  const choices = ORDER.filter(
    (harness) => available[harness] || (harness === "devin" && hasDevinModels)
  )
  const devinMissing = !choices.includes("devin")

  const modelFor = (harness: string): string | undefined => {
    if (harness === "pi") return piModel ? piModel.id : undefined
    if (harness === "devin") return devinModel?.id
    return tuning[harness]?.model ?? defaults[harness]
  }

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
    <div className="max-h-[21rem] overflow-y-auto overscroll-contain">
      {choices.map((harness) => {
        const active = harness !== "devin" && selected === harness
        const model = modelFor(harness)
        return (
          <button
            key={harness}
            type="button"
            onClick={() => pick(harness)}
            className={cn(
              "group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-100",
              active ? "bg-raised" : "hover:bg-raised/60"
            )}
          >
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline",
                "bg-raised/70 transition-colors duration-100",
                active && "border-brand/25 bg-brand-soft"
              )}
            >
              <HarnessIcon harness={harness} className="size-3.5" tinted={active} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "text-[12.5px]",
                    active ? "font-medium text-foreground" : "text-foreground/90"
                  )}
                >
                  {harnessLabel(harness)}
                </span>
                <span className="truncate font-mono text-[10.5px] text-faint">{model ?? ""}</span>
              </span>
              <span className="mt-px block text-[10.5px] text-faint/80">{HOW[harness]}</span>
            </span>
            {active ? <CheckIcon className="size-3.5 shrink-0 text-brand" /> : null}
          </button>
        )
      })}

      {devinMissing ? (
        <div
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 opacity-50"
          title="Devin's models arrive through the pi-devin provider — install and sign in, and this lights up"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-raised/40">
            <HarnessIcon harness="devin" className="size-3.5" tinted={false} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-foreground/70">Devin</span>
            <span className="mt-px block text-[10.5px] text-faint/80">
              Arrives with the pi-devin provider
            </span>
          </span>
        </div>
      ) : null}
    </div>
  )
}
