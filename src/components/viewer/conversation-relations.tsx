import { useState } from "react"
import { createHook, createStore } from "@/state/store"
import { acp, useAcp, activeLiveAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"
import { harnessLabel } from "@/components/rail/harness-meta"

const taskDrafts = createStore<Record<string, string>>({})
const useTaskDrafts = createHook(taskDrafts)

const EMPTY_CHILDREN: never[] = []
export function ConversationRelations() {
  const ancestry = useAcp((state) => activeLiveAcp(state)?.control?.ancestry)
  const pendingMerges = useAcp(
    (state) =>
      activeLiveAcp(state)?.control?.merges.filter(
        (merge) => merge.status === "pending"
      ).length ?? 0
  )
  const children = useAcp(
    (state) => activeLiveAcp(state)?.control?.children ?? EMPTY_CHILDREN
  )
  const hasTask = useAcp((state) =>
    Boolean(
      activeLiveAcp(state)?.requests?.some(
        (request) =>
          request.status === "completed" || request.status === "dispatching"
      )
    )
  )
  const targets = useThreads((state) => state.acpable)
  const conversationId = useAcp((state) => state.activeKey ?? "")
  const task = useTaskDrafts((drafts) => drafts[conversationId] ?? "")
  const setTask = (text: string) =>
    taskDrafts.set((drafts) => ({ ...drafts, [conversationId]: text }))
  const [provider, setProvider] = useState("")
  const [sending, setSending] = useState(false)
  return (
    <div className="shrink-0 border-b border-hairline px-3.5 py-2 text-label text-muted-foreground">
      {ancestry ? (
        <button
          type="button"
          className="pressable mb-2 underline"
          onClick={() => void acp.openRelated(ancestry.parentId)}
        >
          {ancestry.kind === "fork"
            ? "Forked from parent conversation"
            : "Task delegated by parent conversation"}
        </button>
      ) : null}
      {ancestry?.kind === "fork" && hasTask ? (
        <button
          type="button"
          className="pressable ml-3 underline"
          onClick={() => void acp.mergeFork()}
        >
          Send findings to parent
        </button>
      ) : null}
      {pendingMerges > 0 ? (
        <p>
          {pendingMerges} fork results will be included in the next turn. Files
          are unchanged.
        </p>
      ) : null}
      {children.map((child) => (
        <div key={child.id} className="flex items-center gap-2 py-1">
          <button
            type="button"
            className="pressable min-w-0 flex-1 truncate text-left hover:text-foreground"
            onClick={() => void acp.openRelated(child.id)}
          >
            {child.task}
          </button>
          <span>
            {harnessLabel(child.provider)} · {child.status}
          </span>
          {child.delivery === "pending" || child.delivery === "queued" ? (
            <button
              type="button"
              className="pressable underline"
              onClick={() => void acp.cancelChild(child.id)}
            >
              Cancel
            </button>
          ) : null}
        </div>
      ))}
      {hasTask && ancestry?.kind !== "delegation" ? (
        <details>
          <summary className="pressable cursor-pointer">
            Delegate a task
          </summary>
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const submitted = task
              if (!submitted.trim() || sending) return
              setSending(true)
              void acp
                .delegate(provider || targets[0] || "", submitted)
                .then((accepted) => {
                  if (accepted)
                    taskDrafts.set((drafts) =>
                      drafts[conversationId] === submitted
                        ? { ...drafts, [conversationId]: "" }
                        : drafts
                    )
                })
                .finally(() => setSending(false))
            }}
          >
            <label>
              Provider{" "}
              <select
                className="ml-2 rounded border border-hairline bg-surface p-1 text-ui"
                value={provider || targets[0] || ""}
                onChange={(event) => setProvider(event.target.value)}
              >
                {targets.map((target) => (
                  <option key={target} value={target}>
                    {harnessLabel(target)}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              aria-label="Delegated task"
              className="min-h-16 resize-y rounded border border-hairline bg-surface p-2 text-ui"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Give the child a specific task and the context it needs"
            />
            <p>
              The child receives this task in its own workspace snapshot. Its files
              stay separate; findings return to this conversation.
            </p>
            <button
              type="submit"
              disabled={sending || !task.trim() || targets.length === 0}
              className="pressable self-start rounded border border-hairline px-2 py-1 hover:bg-fill-hover disabled:opacity-50"
            >
              {sending ? "Starting child…" : "Start child task"}
            </button>
          </form>
        </details>
      ) : null}
    </div>
  )
}
