import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Slot } from "@/extend/slot"
import { actions, shallowEqual, useSession } from "@/state/session"
import { formatContextWindow, formatCost, formatTokens, workspaceName } from "@/lib/format"
import { cn } from "@/lib/utils"
import { FolderIcon, GitBranchIcon } from "lucide-react"
import { useCallback } from "react"

/**
 * The always-on facts: where we are, what branch, how full the context is,
 * what it has cost. One row, 22px, tabular numerals so nothing jitters while
 * tokens stream.
 */
export function StatusBar() {
  const cwd = useSession((state) => state.meta?.cwd)
  const branch = useSession((state) => state.git?.branch)
  const changed = useSession((state) => state.git?.files.length ?? 0)

  const usage = useSession(
    useCallback(
      (state) => ({
        percent: state.meta?.context?.percent ?? null,
        tokens: state.meta?.context?.tokens ?? null,
        window: state.meta?.context?.contextWindow ?? 0,
        cost: state.meta?.cost ?? 0,
        total: state.meta?.tokens.total ?? 0,
      }),
      []
    ),
    shallowEqual
  )

  const percent = usage.percent ?? 0
  const tone = percent > 90 ? "text-negative" : percent > 72 ? "text-caution" : "text-faint"

  return (
    <footer className="flex h-[22px] shrink-0 items-center gap-3 border-t border-hairline bg-surface px-2.5 text-[11px] text-faint">
      <button
        type="button"
        onClick={() => void actions.pickWorkspace()}
        title={cwd}
        className="no-drag flex min-w-0 items-center gap-1 rounded px-1 transition-colors duration-100 hover:bg-raised hover:text-foreground"
      >
        <FolderIcon className="size-3" />
        <span className="truncate">{workspaceName(cwd)}</span>
      </button>

      {branch ? (
        <span className="flex min-w-0 items-center gap-1">
          <GitBranchIcon className="size-3" />
          <span className="truncate">{branch}</span>
          {changed > 0 ? <span className="text-caution">·{changed}</span> : null}
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        <Slot name="statusbar.trailing" meta={undefined} />

        {/*
         * Both readings are labelled. A bare meter and a bare percentage sat
         * here before and answered nothing: a number with no noun attached is
         * not information, it is decoration that looks like information.
         */}
        {usage.window > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1.5">
                <span className={cn("tabular", tone)}>
                  {usage.tokens == null
                    ? "context —"
                    : `context ${formatTokens(usage.tokens)}/${formatContextWindow(usage.window)}`}
                </span>
                <span className="relative block h-[3px] w-10 overflow-hidden rounded-full bg-raised">
                  <span
                    className={cn(
                      "block h-full rounded-full transition-[width,background-color] duration-500",
                      percent > 90 ? "bg-negative" : percent > 72 ? "bg-caution" : "bg-foreground/45"
                    )}
                    style={{ width: `${Math.min(100, percent)}%` }}
                  />
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {usage.tokens == null
                ? "Context usage is unknown until the next response"
                : `${Math.round(percent)}% of the model's ${formatContextWindow(usage.window)} context window is in use`}
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="tabular">{formatCost(usage.cost)} spent</span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {formatTokens(usage.total)} tokens billed in this session
          </TooltipContent>
        </Tooltip>
      </div>
    </footer>
  )
}
