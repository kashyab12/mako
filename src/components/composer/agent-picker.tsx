import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import { setComposerHarness, useThreads } from "@/state/threads"
import { providers, useProviders } from "@/state/providers"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { harnessModelByIdentity } from "@/lib/types"

/**
 * Who answers. One question, one panel.
 *
 * Each agent is a full row: its mark in a tile, its name, and the model it
 * would use right now — the user's saved choice, or Mako's own sensible
 * default. Each installed agent gets the same row and controls.
 * No filler prose — the rows are the information, and every row earns the
 * same treatment.
 */

const ORDER = ["claude", "codex", "cursor", "grok", "devin", "opencode"]

export function AgentPicker() {
  const [open, setOpen] = useState(false)
  const selected = useThreads((state) => state.composerHarness)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener("mako:pick-agent", show)
    return () => window.removeEventListener("mako:pick-agent", show)
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Agent: ${harnessLabel(selected)}`}
          className={cn(
            "pressable no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2",
            "text-ui font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-fill-hover aria-expanded:bg-fill-selected"
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
  const profiles = useProviders((state) => state.profiles)
  const tuning = useThreads((state) => state.composerTuning)

  useEffect(() => {
    void providers.loadAll()
  }, [])

  const choices = ORDER

  const modelFor = (harness: string): string | undefined => {
    const profile = profiles[harness]
    if (!profile) return tuning[harness]?.model
    return (
      harnessModelByIdentity(profile, tuning[harness]?.model)?.id ??
      tuning[harness]?.model
    )
  }

  const pick = (harness: string) => {
    const profile = profiles[harness]
    if (!profile) return
    if (!profile.available) {
      window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))
      onDone()
      return
    }
    setComposerHarness(harness)
    onDone()
  }

  return (
    <div className="max-h-[21rem] overflow-y-auto overscroll-contain">
      {choices.map((harness) => {
        const profile = profiles[harness]
        const available = profile?.available === true
        const active = available && selected === harness
        const model = modelFor(harness)
        const status = profile
          ? available
            ? model
            : profile.error || "Set up in Agents"
          : "Checking…"
        return (
          <button
            key={harness}
            type="button"
            disabled={!profile}
            onClick={() => pick(harness)}
            className={cn(
              "group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-100 disabled:opacity-50",
              active ? "bg-fill-selected" : "hover:not-disabled:bg-fill-hover"
            )}
          >
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline",
                "bg-raised transition-colors duration-100",
                active && "border-border bg-fill-selected"
              )}
            >
              <HarnessIcon harness={harness} className="size-3.5" tinted={active} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block text-ui",
                  active ? "font-medium text-foreground" : "text-foreground/90"
                )}
              >
                {harnessLabel(harness)}
              </span>
              <span
                title={status}
                className="mt-px block truncate font-mono text-label text-faint"
              >
                {status}
              </span>
            </span>
            {active ? (
              <CheckIcon className="size-3.5 shrink-0 text-foreground" />
            ) : profile && !available ? (
              <span className="shrink-0 text-label text-faint">Set up</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
