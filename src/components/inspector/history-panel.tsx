import { memo, useCallback, useMemo } from "react"
import { Blank } from "@/components/ui/kit"
import { Slot } from "@/extend/slot"
import { checkpointsOf, type Checkpoint } from "@/lib/thread"
import { formatRelative, textOf } from "@/lib/format"
import { acpBlocksToMessages } from "@/lib/acp-blocks"
import { toExchanges } from "@/lib/exchanges"
import { actions, useSession } from "@/state/session"
import { threads, useThreads } from "@/state/threads"
import type { ViewedThread } from "@/state/thread-state"
import { activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { cn } from "@/lib/utils"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  GitBranchPlusIcon,
  HistoryIcon,
  RotateCcwIcon,
  SplitIcon,
} from "lucide-react"

/**
 * Your turns, as rewind points.
 *
 * The unit is the exchange, not the entry: a numbered question with the answer
 * it produced folded underneath it. Settings that were in force ride on the
 * row that used them rather than taking rows of their own, and a branch point
 * collapses into a stepper — the same moment, a different continuation —
 * because indentation is what made the raw graph unreadable.
 */
const EMPTY_BLOCKS: never[] = []

export function HistoryPanel() {
  const tree = useSession((state) => state.tree)
  const viewing = useThreads((state) => state.viewing)
  const acpSession = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const acpBlocks = useAcp((state) => activeAcp(state)?.blocks ?? EMPTY_BLOCKS)
  const checkpoints = useMemo(() => checkpointsOf(tree), [tree])
  const liveTurns = useMemo(() => {
    if (!acpSession) return []
    const conversation = acpBlocksToMessages(
      acpBlocks,
      acpSession.status === "running",
      acpSession.harness
    )
    return toExchanges(conversation.messages)
      .filter((exchange) => exchange.prompt)
      .map((exchange) => ({
        id: exchange.id,
        text: textOf(exchange.prompt?.blocks ?? []),
        reply: exchange.response
          .map((message) => textOf(message.blocks))
          .filter(Boolean)
          .join("\n"),
      }))
  }, [acpBlocks, acpSession])
  const rewind = useCallback((id: string) => void actions.navigate(id), [])
  const branch = useCallback((id: string) => void actions.fork(id), [])

  if (viewing)
    return (
      <ThreadHistory
        thread={viewing}
        liveTurns={acpSession ? liveTurns : []}
      />
    )
  if (acpSession) return <LiveHistory turns={liveTurns} />

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      {checkpoints.length === 0 ? (
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
              onBranch={branch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface HistoryTurn {
  id: string
  text: string
  reply?: string
  at?: string
  entryIndex?: number
}

type ThreadTurn = HistoryTurn & { entryIndex: number }

function LiveHistory({ turns }: { turns: HistoryTurn[] }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      {turns.length === 0 ? (
        <Blank
          icon={<HistoryIcon />}
          title="No turns yet"
          body="Messages from this live agent will appear here as the conversation grows."
        />
      ) : (
        <TurnCards turns={turns} />
      )}
    </div>
  )
}

function turnsOf(thread: ViewedThread): ThreadTurn[] {
  const turns: ThreadTurn[] = []
  for (let index = 0; index < thread.entries.length; index += 1) {
    const entry = thread.entries[index]
    if (entry?.kind !== "user") continue
    let end = index
    let reply: string | undefined
    for (let next = index + 1; next < thread.entries.length; next += 1) {
      const candidate = thread.entries[next]
      if (!candidate || candidate.kind === "user") break
      end = next
      if (candidate.kind === "assistant" && !reply) {
        reply = candidate.blocks.find((block) => block.type === "text")?.text
      }
    }
    turns.push({
      id: `thread-turn-${thread.pageStart + index}`,
      text: entry.text,
      reply,
      at: entry.at,
      entryIndex: thread.pageStart + end,
    })
  }
  return turns
}

function TurnCards({
  turns,
  start = 0,
  onBranch,
}: {
  turns: HistoryTurn[]
  start?: number
  onBranch?: (turn: HistoryTurn) => void
}) {
  return (
    <div className="px-2.5 py-2.5">
      {turns.map((turn, index) => (
        <div
          key={turn.id}
          className="contain-turn relative ml-6 mb-1.5 rounded-xl px-2.5 py-2 ring-1 ring-transparent hover:bg-fill-hover hover:ring-hairline [contain-intrinsic-size:auto_68px]"
        >
          <span className="tabular absolute top-2.5 -left-[19px] flex size-[15px] items-center justify-center rounded-full bg-surface text-label font-semibold text-faint ring-1 ring-hairline">
            {start + index + 1}
          </span>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-ui leading-snug text-foreground/90">
                {turn.text || "Empty message"}
              </p>
              {turn.reply ? (
                <p className="mt-1 flex items-start gap-1 text-label leading-snug text-faint">
                  <CornerDownRightIcon className="mt-[3px] size-2.5 shrink-0 opacity-70" />
                  <span className="line-clamp-1 min-w-0">{turn.reply}</span>
                </p>
              ) : null}
            </div>
            {turn.at ? (
              <span className="tabular shrink-0 text-label text-faint">
                {formatRelative(turn.at)}
              </span>
            ) : null}
            {onBranch && turn.entryIndex !== undefined ? (
              <button
                type="button"
                title="Branch from this turn into a new session"
                onClick={() => onBranch(turn)}
                className="pressable flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-label text-faint ring-1 ring-hairline hover:text-foreground"
              >
                <GitBranchPlusIcon className="size-2.5" />
                Branch
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function ThreadHistory({
  thread,
  liveTurns,
}: {
  thread: ViewedThread
  liveTurns: Array<Pick<ThreadTurn, "id" | "text" | "reply">>
}) {
  const turns = useMemo(() => turnsOf(thread), [thread])
  const pending = liveTurns.filter(
    (turn, index) => index > 0 || turn.text !== turns.at(-1)?.text
  )
  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      {thread.hasEarlier ? (
        <button
          type="button"
          disabled={thread.loadingEarlier}
          onClick={() => void threads.loadEarlier()}
          className="pressable mx-3 mt-3 rounded-md border border-hairline px-2 py-1 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground disabled:opacity-50"
        >
          {thread.loadingEarlier ? "Loading earlier turns…" : "Show earlier turns"}
        </button>
      ) : null}
      {turns.length === 0 && pending.length === 0 ? (
        <Blank
          icon={<HistoryIcon />}
          title="No readable turns"
          body="This provider session has no user turns in its loaded history."
        />
      ) : (
        <>
          <TurnCards
            turns={turns}
            onBranch={(turn) => {
              if (turn.entryIndex === undefined) return
              void threads.forkAt(
                thread.ref,
                turn.entryIndex,
                thread.ref.harness
              )
            }}
          />
          <TurnCards turns={pending} start={turns.length} />
        </>
      )}
    </div>
  )
}

const Row = memo(function Row({
  checkpoint,
  index,
  onRewind,
  onBranch,
}: {
  checkpoint: Checkpoint
  index: number
  onRewind: (id: string) => void
  onBranch: (id: string) => void
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
          // The ring is always there, and only its colour changes. Adding a
          // ring on hover means going from no box-shadow to one, which the
          // browser cannot interpolate — the edge snapped into existence
          // instead of fading up.
          "ring-1",
          current ? "bg-fill-selected ring-border" : "ring-transparent hover:bg-fill-hover hover:ring-hairline"
        )}
      >
        {/* The marker sits on the spine, not inside the card. */}
        <span
          className={cn(
            "tabular absolute top-2.5 -left-[19px] z-10 flex size-[15px] items-center justify-center rounded-full",
            "text-label font-semibold [transition:background-color_160ms_ease,color_160ms_ease,box-shadow_160ms_ease]",
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
                "line-clamp-2 min-w-0 flex-1 text-ui leading-snug",
                current ? "font-medium text-foreground" : live ? "text-foreground/85" : "text-faint"
              )}
            >
              {checkpoint.text || "Empty message"}
            </p>
            {checkpoint.timestamp ? (
              <span className="tabular shrink-0 text-label text-faint">
                {formatRelative(checkpoint.timestamp)}
              </span>
            ) : null}
          </div>

          {checkpoint.reply ? (
            <p className="mt-1 flex items-start gap-1 text-label leading-snug text-faint">
              <CornerDownRightIcon className="mt-[3px] size-2.5 shrink-0 opacity-70" />
              <span className="line-clamp-1 min-w-0">{checkpoint.reply}</span>
            </p>
          ) : null}

          {/* Metadata sits on one quiet line rather than stacking rows. */}
          {checkpoint.settings.length > 0 || !live ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {!live ? (
                <span className="rounded bg-raised px-1 py-px text-label text-faint">
                  off branch
                </span>
              ) : null}
              {checkpoint.settings.map((setting) => (
                <span
                  key={setting}
                  className="truncate rounded bg-raised px-1.5 py-px text-label text-faint/80"
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
        {/* Two different things, so two controls. Rewind moves *this*
            conversation back onto another branch and abandons where you were.
            Branch leaves it exactly as it is and opens a new session from that
            turn — which is what you want when the point is to try the same
            question two ways and compare. */}
        <div
          className={cn(
            "absolute top-1.5 right-1.5 flex items-center gap-1",
            "opacity-0 transition-opacity duration-150",
            "group-hover:opacity-100 focus-within:opacity-100"
          )}
        >
          <CheckpointAction
            label="Branch"
            title="Continue from this turn in a new tab, leaving this one running"
            icon={<GitBranchPlusIcon className="size-2.5" />}
            onClick={() => onBranch(checkpoint.id)}
          />
          {!current ? (
            <CheckpointAction
              label="Rewind"
              title="Move this conversation back to here"
              icon={<RotateCcwIcon className="size-2.5" />}
              onClick={() => onRewind(checkpoint.id)}
            />
          ) : null}
        </div>

        <Slot name="history.checkpoint.trailing" checkpoint={checkpoint} />
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
    <div className="mt-1.5 flex items-center gap-1 rounded-md bg-raised py-0.5 pr-1.5 pl-1">
      <SplitIcon className="size-2.5 shrink-0 text-faint" />
      <button
        type="button"
        aria-label="Previous take"
        onClick={() => step(-1)}
        className="pressable flex size-4 items-center justify-center rounded text-faint hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3" />
      </button>
      <span className="tabular shrink-0 text-label text-muted-foreground">
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
      <span className="min-w-0 flex-1 truncate text-label text-faint">{takes[at]?.preview}</span>
    </div>
  )
}

/** One of the two things you can do to a past turn. */
function CheckpointAction({
  label,
  title,
  icon,
  onClick,
}: {
  label: string
  title: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "pressable flex h-5 items-center gap-1 rounded-md px-1.5",
        "bg-surface/80 text-label text-faint ring-1 ring-hairline backdrop-blur-sm",
        "transition-colors duration-120 hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  )
}
