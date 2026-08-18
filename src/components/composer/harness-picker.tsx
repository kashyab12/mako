import { useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/agent-threads"
import { threadsStore, useThreads } from "@/state/threads"
import { getPi, hasBridge } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

/**
 * Which agent answers the next new conversation.
 *
 * The chat column is harness-first: Pi runs natively in this tab, and every
 * other agent on the machine runs headlessly in this workspace, its
 * conversation opening right here the moment its session file lands. Only
 * harnesses whose CLIs actually exist are offered — a menu of things that
 * error is a menu of traps.
 *
 * Model, reasoning, and mode selection per harness ride on top of this
 * next; today a foreign harness runs with its own defaults, and Pi keeps
 * its full picker.
 */
export function HarnessPicker() {
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<Record<string, boolean>>({ pi: true })
  const selected = useThreads((state) => state.composerHarness)

  useEffect(() => {
    if (!hasBridge()) return
    void getPi()
      .harnessAvailability()
      .then(setAvailable)
      .catch(() => {})
  }, [])

  const choices = ["pi", "claude", "codex", "cursor", "grok"].filter(
    (harness) => available[harness]
  )
  if (choices.length <= 1) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Which agent answers"
          className={cn(
            "pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11.5px] transition-colors duration-150",
            selected === "pi" ? "text-faint hover:text-muted-foreground" : "bg-raised text-foreground"
          )}
        >
          <HarnessIcon harness={selected} className="size-3.5" />
          {selected !== "pi" ? harnessLabel(selected) : null}
          <ChevronDownIcon className="size-2.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-60 p-1">
        <p className="px-2 pt-1 pb-1.5 text-[10.5px] text-faint">New conversations go to</p>
        {choices.map((harness) => (
          <button
            key={harness}
            type="button"
            onClick={() => {
              threadsStore.set({ composerHarness: harness })
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground/90 transition-colors hover:bg-raised"
          >
            <HarnessIcon harness={harness} className="size-3.5" />
            <span className="min-w-0 flex-1">{harnessLabel(harness)}</span>
            <span className="text-[10px] text-faint">
              {harness === "pi" ? "native, this tab" : "headless, opens here"}
            </span>
            {selected === harness ? <CheckIcon className="size-3 text-foreground/70" /> : null}
          </button>
        ))}
        <p className="px-2 pt-1.5 pb-1 text-[10px] leading-snug text-faint">
          Foreign agents run in this workspace with their own defaults; the
          conversation appears here as it works.
        </p>
      </PopoverContent>
    </Popover>
  )
}
