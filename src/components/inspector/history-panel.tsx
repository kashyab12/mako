import { memo, useCallback, useMemo, useState } from "react"
import { Blank } from "@/components/ui/kit"
import { GitLog } from "@/components/inspector/git-log"
import { Slot } from "@/extend/slot"
import { checkpointsOf, type Checkpoint } from "@/lib/thread"
import { formatRelative } from "@/lib/format"
import { actions, useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  HistoryIcon,
  RotateCcwIcon,
  SplitIcon,
} from "lucide-react"

type Lane = "turns" | "commits"

/**
 * Your turns, as rewind points.
 *
 * The unit is the exchange, not the entry: a numbered question with the answer
 * it produced folded underneath it. Settings that were in force ride on the
 * row that used them rather than taking rows of their own, and a branch point
 * collapses into a stepper — the same moment, a different continuation —
 * because indentation is what made the raw graph unreadable.
 */
export function HistoryPanel() {
  const [lane, setLane] = useState<Lane>("turns")
  const hasRepo = useSession((state) => Boolean(state.git?.root))
  const tree = useSession((state) => state.tree)

  const checkpoints = useMemo(() => checkpointsOf(tree), [tree])
  const rewind = useCallback((id: string) => void actions.navigate(id), [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hasRepo ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-2.5">
          <LaneTab
            label="Turns"
            count={checkpoints.length}
            active={lane === "turns"}
            onClick={() => setLane("turns")}
          />
          <LaneTab label="Commits" active={lane === "commits"} onClick={() => setLane("commits")} />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {lane === "commits" && hasRepo ? (
          <GitLog />
        ) : checkpoints.length === 0 ? (
          <Blank
            icon={<HistoryIcon />}
            title="No turns yet"
            body="Every message you send becomes a point you can rewind to. Nothing is deleted — going back only moves where the conversation continues."
          />
        ) : (
          <div className="px-2.5 py-2.5">
            {checkpoints.map((checkpoint, index) => (
              <Row
                key={checkpoint.id}
                checkpoint={checkpoint}
                index={index + 1}
                onRewind={rewind}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const Row = memo(function Row({
  checkpoint,
  index,
  onRewind,
}: {
  checkpoint: Checkpoint
  index: number
  onRewind: (id: string) => void
}) {
  const { current, live } = checkpoint

  return (
    <div className="contain-turn group relative [contain-intrinsic-size:auto_78px]">
      {/* The spine. It runs behind the markers and fades at both ends so the
          timeline reads as continuous without terminating in a hard stub. */}
      <span
        aria-hidden
        className="absolute top-0 bottom-0 left-[15px] w-px bg-gradient-to-b from-transparent via-hairline to-transparent"
      />

      <div
        className={cn(
          "relative ml-[26px] mb-1.5 rounded-xl px-2.5 py-2",
          "[transition:background-color_160ms_ease,box-shadow_160ms_ease,transform_160ms_var(--ease-out)]",
          current
            ? "raised-card ring-1 ring-border"
            : "hover:raised-card hover:ring-1 hover:ring-hairline"
        )}
      >
        {/* The marker sits on the spine, not inside the card. */}
        <span
          className={cn(
            "tabular absolute top-2.5 -left-[19px] z-10 flex size-[15px] items-center justify-center rounded-full",
            "text-[9px] font-semibold [transition:background-color_160ms_ease,color_160ms_ease,box-shadow_160ms_ease]",
            current
              ? "bg-foreground text-background shadow-[0_0_0_3px_var(--surface),0_0_12px_2px_oklch(1_0_0/18%)]"
              : live
                ? "bg-raised text-muted-foreground shadow-[0_0_0_3px_var(--surface)] ring-1 ring-border"
                : "bg-surface text-faint/70 shadow-[0_0_0_3px_var(--surface)] ring-1 ring-hairline"
          )}
        >
          {index}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p
              className={cn(
                "line-clamp-2 min-w-0 flex-1 text-[12px] leading-snug",
                current ? "font-medium text-foreground" : live ? "text-foreground/85" : "text-faint"
              )}
            >
              {checkpoint.text || "Empty message"}
            </p>
            {checkpoint.timestamp ? (
              <span className="tabular shrink-0 text-[10px] text-faint">
                {formatRelative(checkpoint.timestamp)}
              </span>
            ) : null}
          </div>

          {checkpoint.reply ? (
            <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-faint">
              <CornerDownRightIcon className="mt-[3px] size-2.5 shrink-0 opacity-70" />
              <span className="line-clamp-1 min-w-0">{checkpoint.reply}</span>
            </p>
          ) : null}

          {/* Metadata sits on one quiet line rather than stacking rows. */}
          {checkpoint.settings.length > 0 || !live ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {!live ? (
                <span className="rounded bg-raised px-1 py-px text-[9.5px] text-faint">
                  off branch
                </span>
              ) : null}
              {checkpoint.settings.map((setting) => (
                <span
                  key={setting}
                  className="truncate rounded bg-raised/70 px-1 py-px font-mono text-[9.5px] text-faint/80"
                >
                  {setting}
                </span>
              ))}
            </div>
          ) : null}

          {checkpoint.takes.length > 0 ? (
            <Takes takes={checkpoint.takes} onPick={onRewind} />
          ) : null}
        </div>

        {/* Rewind is an explicit control, not the whole card: moving the
            conversation is too consequential to trigger by a stray click. */}
        {!current ? (
          <button
            type="button"
            title="Continue the conversation from here"
            onClick={() => onRewind(checkpoint.id)}
            className={cn(
              "pressable absolute top-1.5 right-1.5 flex h-5 items-center gap-1 rounded-md px-1.5",
              "bg-surface/80 text-[10px] text-faint ring-1 ring-hairline backdrop-blur-sm",
              "opacity-0 transition-opacity duration-150",
              "hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            )}
          >
            <RotateCcwIcon className="size-2.5" />
            Rewind
          </button>
        ) : null}

        <Slot name="inspector.history.trailing" checkpoint={checkpoint} />
      </div>
    </div>
  )
})

/**
 * A branch point, as a stepper rather than as indentation: from the reader's
 * side that is exactly what it is — one moment with more than one answer.
 */
function Takes({ takes, onPick }: { takes: Checkpoint["takes"]; onPick: (id: string) => void }) {
  const at = Math.max(
    0,
    takes.findIndex((take) => take.live)
  )
  const step = (delta: number) => {
    const next = takes[(at + delta + takes.length) % takes.length]
    if (next) onPick(next.id)
  }

  return (
    <div className="mt-1.5 flex items-center gap-1 rounded-md bg-raised/60 py-0.5 pr-1.5 pl-1">
      <SplitIcon className="size-2.5 shrink-0 text-faint" />
      <button
        type="button"
        aria-label="Previous take"
        onClick={() => step(-1)}
        className="pressable flex size-4 items-center justify-center rounded text-faint hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3" />
      </button>
      <span className="tabular shrink-0 text-[10px] text-muted-foreground">
        {at + 1}/{takes.length}
      </span>
      <button
        type="button"
        aria-label="Next take"
        onClick={() => step(1)}
        className="pressable flex size-4 items-center justify-center rounded text-faint hover:text-foreground"
      >
        <ChevronRightIcon className="size-3" />
      </button>
      <span className="min-w-0 flex-1 truncate text-[10px] text-faint">{takes[at]?.preview}</span>
    </div>
  )
}

function LaneTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-8 items-center gap-1.5 text-[11.5px] transition-colors duration-100",
        active ? "text-foreground" : "text-faint hover:text-muted-foreground"
      )}
    >
      {label}
      {count !== undefined && count > 0 ? (
        <span className="tabular text-[10px] text-faint">{count}</span>
      ) : null}
      <span
        className={cn(
          "absolute inset-x-0 -bottom-px h-px transition-opacity duration-150",
          active ? "bg-foreground/60 opacity-100" : "opacity-0"
        )}
      />
    </button>
  )
}
