import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import {
  harnessDefault,
  setComposerHarness,
  setComposerTuning,
  threadsStore,
  useThreads,
} from "@/state/threads"
import { getMako, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { harnessModelByIdentity } from "@/lib/types"
import type { HarnessProfile } from "@/lib/types"

/**
 * Who answers. One question, one panel.
 *
 * Each agent is a full row: its mark in a tile, its name, and the model it
 * would use right now — the user's saved choice, or Mako's own sensible
 * default. Five hands, one bar: Claude Code, Codex, Cursor, Grok, Devin.
 * No filler prose — the rows are the information, and every row earns the
 * same treatment.
 */

const ORDER = ["claude", "codex", "cursor", "grok", "devin"]

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
  const [profiles, setProfiles] = useState<Record<string, HarnessProfile>>({})
  const tuning = useThreads((state) => state.composerTuning)

  useEffect(() => {
    if (!hasBridge()) return
    void getMako()
      .harnessProfiles()
      .then((items) => {
        const next = Object.fromEntries(items.map((profile) => [profile.id, profile]))
        setProfiles(next)
        for (const [harness, current] of Object.entries(
          threadsStore.get().composerTuning
        )) {
          if (!current.model || !next[harness]) continue
          const canonical = harnessModelByIdentity(next[harness], current.model)
          if (canonical?.id === current.model) continue
          setComposerTuning(harness, {
            model: canonical?.id,
            effort: undefined,
            fast: undefined,
            options: undefined,
          })
        }
      })
      .catch(() => {})
  }, [])

  const choices = ORDER.filter((harness) => profiles[harness]?.available)

  const modelFor = (harness: string): string | undefined => {
    const profile = profiles[harness]
    if (!profile) return harnessDefault(harness).model
    return harnessModelByIdentity(profile, tuning[harness]?.model)?.id ??
      harnessModelByIdentity(
        profile,
        profile.configuredModel ?? profile.defaultModel
      )?.id
  }

  const pick = (harness: string) => {
    setComposerHarness(harness)
    onDone()
  }

  return (
    <div className="max-h-[21rem] overflow-y-auto overscroll-contain">
      {choices.map((harness) => {
        const active = selected === harness
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
              <span
                className={cn(
                  "block text-[12.5px]",
                  active ? "font-medium text-foreground" : "text-foreground/90"
                )}
              >
                {harnessLabel(harness)}
              </span>
              <span className="mt-px block truncate font-mono text-[10.5px] text-faint">
                {model ?? ""}
              </span>
            </span>
            {active ? <CheckIcon className="size-3.5 shrink-0 text-brand" /> : null}
          </button>
        )
      })}
    </div>
  )
}
