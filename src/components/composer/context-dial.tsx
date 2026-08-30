import { memo } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { contextAccounting } from "@/lib/context-accounting"
import { formatContextWindow, formatCost, formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"
import { activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { useProviders } from "@/state/providers"
import { useSession } from "@/state/session"
import { stage } from "@/state/stage"
import { useThreads } from "@/state/threads"
import { harnessTitle } from "@/components/composer/harness-title"

/**
 * The context dial — OpenCode's answer, adopted whole. A 16px progress
 * circle is the entire inline footprint; the numbers live in its tooltip,
 * each with its noun, and clicking it opens the Context surface. A fresh
 * session shows an empty ring, not a row of zeros. One shallow-compared
 * selector, so streaming token counts wake this span and nothing else.
 */
export const ContextDial = memo(function ContextDial() {
  const meta = useSession((state) => state.meta)
  const viewing = useThreads((state) => state.viewing)
  const composerHarness = useThreads((state) => state.composerHarness)
  const acpSession = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const acpStarting = useAcp((state) => activeAcp(state)?.kind === "starting")
  const profiles = useProviders((state) => state.profiles)
  const usage = contextAccounting({
    meta,
    viewing,
    acpSession,
    acpStarting,
    composerHarness,
    profiles,
  })
  const percent =
    usage.kind === "exact" ? Math.min(100, usage.percent ?? 0) : 0
  const tone =
    percent > 90
      ? "text-negative"
      : percent > 72
        ? "text-caution"
        : "text-muted-foreground"
  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Context and spend"
          onClick={() => stage.toggle("context")}
          className="pressable flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-100 hover:bg-fill-hover"
        >
          <svg viewBox="0 0 16 16" className={cn("size-4 -rotate-90", tone)} aria-hidden>
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="2"
              className="stroke-foreground/15"
            />
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              stroke="currentColor"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - percent / 100)}
              className="transition-[stroke-dashoffset] duration-500"
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex-col items-stretch gap-1">
        {usage.kind === "exact" ? (
          <>
            <Reading label="spent" value={formatCost(usage.cost)} />
            <Reading
              label="context"
              value={
                usage.window > 0 && usage.tokens != null
                  ? `${Math.round(percent)}% · ${formatTokens(usage.tokens)} of ${formatContextWindow(usage.window)}`
                  : "unknown until the next response"
              }
            />
          </>
        ) : usage.kind === "reported-input" ? (
          <>
            <Reading
              label="session spend"
              value={usage.cost == null ? "not reported" : formatCost(usage.cost)}
            />
            <Reading
              label="last input"
              value={
                usage.lastInput == null
                  ? "not reported"
                  : formatTokens(usage.lastInput)
              }
            />
            {usage.window > 0 ? (
              <Reading
                label="model window"
                value={formatContextWindow(usage.window)}
              />
            ) : null}
          </>
        ) : (
          <Reading
            label="context"
            value={`not reported by ${harnessTitle(usage.harness)} live sessions`}
          />
        )}
      </TooltipContent>
    </Tooltip>
  )
})

export function Reading({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex justify-between gap-4">
      <span className="opacity-70">{label}</span>
      <span className="tabular">{value}</span>
    </span>
  )
}
