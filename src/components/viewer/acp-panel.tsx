import { useEffect, useMemo, useState } from "react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { SearchSelect } from "@/components/ui/search-select"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import {
  acpBlocksToMessages,
  type AcpPlanEntry,
} from "@/lib/acp-blocks"
import { toExchanges } from "@/lib/exchanges"
import { foldTools } from "@/lib/tools"
import { acp, acpStore, useAcp } from "@/state/acp"
import type { AcpPermissionRequest } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  CheckCheckIcon,
  CheckIcon,
  CircleIcon,
  Loader2Icon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react"

/**
 * A foreign agent, live.
 *
 * This is the difference between reading another harness's session and
 * *driving* it: tokens stream as they are generated, tool calls appear as
 * they run, and when the agent wants a permission its mode does not grant,
 * the question lands here — with the agent's own options, not a yes/no we
 * invented. A Claude Code thread opened this way is the same session its CLI
 * would resume, not a copy. The one composer below the column does the
 * talking; this surface is the transcript, the permission question, and the
 * agent's own modes.
 */

export function AcpPanel() {
  const session = useAcp((state) => state.session)
  const starting = useAcp((state) => state.starting)

  useEffect(() => {
    if (!session) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === "Escape") {
        event.preventDefault()
        // Permission prompts consume Escape first; otherwise the same muscle
        // memory as the native transcript stops a running turn. Only an idle
        // Escape closes the session.
        if (acpStore.get().permission) acp.answerPermission(null)
        else if (acpStore.get().session?.status === "running") acp.cancel()
        else acp.close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [session])

  if (starting) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
        <div className="flex items-center gap-2 text-ui text-faint">
          <Loader2Icon className="size-4 animate-spin" />
          Starting the agent…
        </div>
      </div>
    )
  }
  if (!session) return null

  return (
    <div className="animate-enter flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-hairline px-3.5">
        <HarnessIcon harness={session.harness} className="size-3.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium">
            {session.title ?? `${harnessLabel(session.harness)}, live`}
          </p>
          <p className="truncate text-label text-faint">
            {harnessLabel(session.harness)} · live · {session.cwd}
          </p>
        </div>
        <ModePicker />
        <button
          type="button"
          aria-label="End live session"
          title="Ends the live session — the conversation stays in Threads"
          onClick={() => acp.close()}
          className="pressable shrink-0 rounded p-1 text-faint hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <Blocks />
      <Permission />
    </div>
  )
}

/**
 * The agent's own modes, verbatim. "acceptEdits" and "plan" are its words
 * for its behaviours; renaming them here would mean documenting a mapping
 * forever.
 */
function ModePicker() {
  const session = useAcp((state) => state.session)
  if (!session || session.modes.length === 0) return null
  return (
    <SearchSelect
      value={session.currentMode ?? ""}
      label="Agent mode"
      searchPlaceholder="Search modes"
      className="w-36 shrink-0"
      options={session.modes.map((mode) => ({
        value: mode.id,
        label: mode.name,
      }))}
      onChange={(next) => acp.setMode(next)}
    />
  )
}

function Blocks() {
  const session = useAcp((state) => state.session)
  const blocks = useAcp((state) => state.blocks)
  const running = session?.status === "running"
  const conversation = useMemo(
    () => acpBlocksToMessages(blocks, running),
    [blocks, running]
  )
  const exchanges = useMemo(
    () => toExchanges(foldTools(conversation.messages)),
    [conversation.messages]
  )
  const lastExchangeId = exchanges.at(-1)?.id

  return (
    <ConversationTimeline
      identity={session?.id ?? "acp"}
      exchanges={exchanges}
      streamingId={running ? lastExchangeId : undefined}
      failedId={session?.status === "failed" ? lastExchangeId : undefined}
      empty={
        <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-6 py-6">
          <p className="pt-8 text-center text-ui leading-relaxed text-faint">
            The session is loaded. Anything you send continues it — same
            conversation, same working directory.
          </p>
          <AcpActivity plan={conversation.plan} running={running} />
        </div>
      }
      footer={<AcpActivity plan={conversation.plan} running={running} />}
    />
  )
}

function AcpActivity({
  plan,
  running,
}: {
  plan: AcpPlanEntry[]
  running: boolean
}) {
  return (
    <>
      {plan.length > 0 ? <Plan entries={plan} /> : null}
      {running ? (
        <div className="flex items-center gap-1.5 py-2 text-label text-faint">
          <Loader2Icon className="size-3 animate-spin" />
          working
        </div>
      ) : null}
    </>
  )
}

function Plan({ entries }: { entries: AcpPlanEntry[] }) {
  return (
    <div className="contain-turn rounded-md border border-hairline/60 px-2.5 py-1.5">
      <p className="pb-1 text-label font-medium text-faint">Plan</p>
      {entries.map((entry, index) => (
        <p
          key={index}
          className="flex items-center gap-1.5 py-px text-ui text-muted-foreground"
        >
          {entry.status === "completed" ? (
            <CheckIcon className="size-3 text-positive/80" />
          ) : entry.status === "in_progress" ? (
            <Loader2Icon className="size-3 animate-spin text-faint" />
          ) : (
            <CircleIcon className="size-2.5 text-faint/60" />
          )}
          <span
            className={cn(
              entry.status === "completed" && "text-faint line-through"
            )}
          >
            {entry.content}
          </span>
        </p>
      ))}
    </div>
  )
}

/**
 * The agent's question, with the agent's answers.
 *
 * Choices and structured questions come from the agent and render without
 * inventing a second permission vocabulary. This should read as a question,
 * not an alert.
 */
function Permission() {
  const permission = useAcp((state) => state.permission)
  if (!permission) return null
  if (permission.questions?.length)
    return <QuestionPermission key={permission.id} permission={permission} />
  return (
    <div className="shrink-0 border-t border-hairline bg-surface/60 px-4 py-2.5">
      <p className="flex items-center gap-1.5 text-ui text-foreground/90">
        <ShieldQuestionIcon className="size-3.5 shrink-0 text-caution/90" />
        <span className="min-w-0 truncate font-mono">{permission.title}</span>
      </p>
      <p className="pt-0.5 pb-2 text-label text-faint">
        Choose how long to allow it. Escape denies this request.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {permission.options.map((option) => {
          const allow = option.kind?.startsWith("allow") === true
          const always = option.kind === "allow_always"
          return (
            <button
              key={option.optionId}
              type="button"
              onClick={() => acp.answerPermission(option.optionId)}
              className={cn(
                "pressable flex items-center gap-1.5 rounded-md border px-2 py-1 text-label transition-colors",
                allow && !always
                  ? "border-hairline bg-foreground text-background hover:opacity-90"
                  : always
                    ? "border-foreground/20 text-foreground hover:bg-fill-hover"
                    : "border-hairline text-negative/80 hover:bg-negative/10 hover:text-negative"
              )}
            >
              {always ? (
                <CheckCheckIcon className="size-3" />
              ) : allow ? (
                <CheckIcon className="size-3" />
              ) : (
                <XIcon className="size-3" />
              )}
              {option.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function QuestionPermission({
  permission,
}: {
  permission: AcpPermissionRequest
}) {
  const questions = permission.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const complete = questions.every(
    (question) => answers[question.id]?.trim().length
  )
  return (
    <div className="shrink-0 border-t border-hairline bg-surface/60 px-4 py-3">
      <p className="flex items-center gap-1.5 pb-2 text-ui text-foreground/90">
        <ShieldQuestionIcon className="size-3.5 shrink-0 text-caution/90" />
        <span className="min-w-0 truncate">{permission.title}</span>
      </p>
      <div className="max-h-72 space-y-3 overflow-y-auto">
        {questions.map((question) => (
          <fieldset key={question.id} className="space-y-1.5">
            <legend className="text-ui font-medium text-foreground/90">
              {question.header || question.question}
            </legend>
            {question.header && question.question !== question.header ? (
              <p className="text-label text-faint">{question.question}</p>
            ) : null}
            {question.options.length ? (
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    title={option.description || undefined}
                    onClick={() =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: option.label,
                      }))
                    }
                    className={cn(
                      "pressable rounded-md border px-2 py-1 text-label",
                      answers[question.id] === option.label
                        ? "border-foreground/20 bg-fill-selected text-foreground"
                        : "border-hairline text-muted-foreground hover:bg-fill-hover hover:text-foreground"
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            {!question.options.length || question.allowOther ? (
              <input
                type={question.isSecret ? "password" : "text"}
                value={answers[question.id] ?? ""}
                placeholder={
                  question.options.length ? "Other answer" : "Type your answer"
                }
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                className="h-8 w-full rounded-md border border-hairline bg-surface px-2 text-ui text-foreground placeholder:text-faint focus:outline-none"
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-3">
        <button
          type="button"
          onClick={() => acp.answerPermission(null)}
          className="pressable rounded-md border border-hairline px-2 py-1 text-label text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!complete}
          onClick={() =>
            acp.answerPermission(
              null,
              Object.fromEntries(
                Object.entries(answers).map(([id, answer]) => [
                  id,
                  [answer.trim()],
                ])
              )
            )
          }
          className="pressable rounded-md bg-foreground px-2 py-1 text-label text-background disabled:opacity-40"
        >
          Send answers
        </button>
      </div>
    </div>
  )
}

