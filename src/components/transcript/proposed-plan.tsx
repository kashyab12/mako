import { useRef, useState } from "react"
import type { ProposedPlan } from "@mako/sessions/content"
import {
  CheckIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Prose } from "./markdown"
import { useTranscriptSource } from "./source-context"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { useCopy } from "@/components/ui/use-copy"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  proposedPlanFilename,
  proposedPlanMarkdown,
  proposedPlanTitle,
} from "@/lib/proposed-plan"
import { downloadPlan, draftPlanReply, savePlan } from "@/state/plans"

export function ProposedPlanCard({
  plan,
  streaming,
}: {
  plan: ProposedPlan
  streaming?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const source = useTranscriptSource()
  const focus = useWorkspaceFocus()
  const [saving, setSaving] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [path, setPath] = useState("")
  const pathInput = useRef<HTMLInputElement>(null)
  const planActions = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState("")
  const { copied, copy } = useCopy(proposedPlanMarkdown(plan))
  const complete = plan.status === "proposed"
  const title = proposedPlanTitle(plan.text)
  const canDraft =
    complete &&
    !streaming &&
    !plan.truncated &&
    Boolean(source.liveId || source.threadPath)
  const prepare = (intent: "implement" | "revise") => {
    try {
      draftPlanReply(source, plan, intent)
      window.dispatchEvent(new CustomEvent("mako:focus-composer"))
    } catch (failure) {
      toast.error("The reply could not be prepared", {
        description:
          failure instanceof Error
            ? failure.message
            : "Open the plan's conversation and try again.",
      })
    }
  }
  return (
    <section
      className="rounded-lg border border-hairline bg-card text-ui"
      aria-label="Proposed plan"
    >
      <div className="flex items-start gap-2 px-3 py-3">
        <button
          type="button"
          aria-expanded={expanded}
          className="pressable flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            className={`mt-0.5 size-3.5 shrink-0 text-faint ${expanded ? "rotate-180" : ""}`}
          />
          <span className="min-w-0">
            <span className="block font-medium">{title}</span>
            <span className="mt-1 block text-label text-faint">
              {complete
                ? "Proposed plan"
                : streaming
                  ? "Writing plan…"
                  : "Incomplete plan"}
            </span>
          </span>
        </button>
        <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              ref={planActions}
              aria-label={copied ? "Plan copied" : "Plan actions"}
              className="pressable rounded p-1 text-faint hover:bg-fill-hover"
            >
              {copied ? (
                <CheckIcon className="size-4" />
              ) : (
                <MoreHorizontalIcon className="size-4" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-1">
            <button
              type="button"
              className="pressable block w-full rounded px-2 py-2 text-left text-ui hover:bg-fill-hover"
              onClick={() => {
                void copy()
                setActionsOpen(false)
              }}
            >
              {copied ? "Copied" : "Copy Markdown"}
            </button>
            <button
              type="button"
              className="pressable block w-full rounded px-2 py-2 text-left text-ui hover:bg-fill-hover"
              onClick={() => {
                downloadPlan(plan)
                setActionsOpen(false)
              }}
            >
              Download Markdown
            </button>
            <button
              type="button"
              disabled={!focus.cwd || !focus.ready}
              className="pressable block w-full rounded px-2 py-2 text-left text-ui hover:bg-fill-hover disabled:opacity-40"
              onClick={() => {
                setPath(proposedPlanFilename(plan.text))
                setError("")
                setActionsOpen(false)
                setSaveOpen(true)
              }}
            >
              Save to workspace…
            </button>
          </PopoverContent>
        </Popover>
      </div>
      {expanded ? (
        <div className="border-t border-hairline px-3 py-3">
          <Prose text={plan.text} streaming={streaming && !complete} />
        </div>
      ) : null}
      {plan.truncated ? (
        <p className="px-3 pb-3 text-label text-faint">
          The plan exceeded the capture limit. Export includes the saved
          portion; request a shorter plan before continuing.
        </p>
      ) : null}
      {source.liveId || source.threadPath ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-3 py-2">
          <button
            type="button"
            disabled={!canDraft}
            className="pressable rounded-md border border-hairline px-2 py-1 text-ui hover:bg-fill-hover disabled:opacity-40"
            onClick={() => prepare("implement")}
          >
            Draft implementation
          </button>
          <button
            type="button"
            disabled={!canDraft}
            className="pressable rounded-md px-2 py-1 text-ui text-faint hover:bg-fill-hover disabled:opacity-40"
            onClick={() => prepare("revise")}
          >
            Draft revision
          </button>
          <span className="text-label text-faint">
            Review in the composer before sending
          </span>
        </div>
      ) : null}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent
          className="w-[min(100vw_-_32px,440px)] p-5"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            planActions.current?.focus()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            pathInput.current?.focus()
            pathInput.current?.select()
          }}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close save plan"
                className="pressable rounded p-1 text-faint hover:bg-fill-hover"
              >
                <XIcon className="size-4" />
              </button>
            </DialogClose>
          </div>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!focus.cwd || !path.trim() || saving) return
              setSaving(true)
              setError("")
              void savePlan(focus.cwd, path, plan)
                .then((saved) => {
                  setSaveOpen(false)
                  toast.success("Plan saved", { description: saved })
                })
                .catch((failure) =>
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "The plan could not be saved."
                  )
                )
                .finally(() => setSaving(false))
            }}
          >
            <label className="flex flex-col gap-2 text-ui">
              New Markdown file
              <input
                ref={pathInput}
                aria-label="Plan file path"
                className="rounded-md border border-hairline bg-surface px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <p className="text-label break-all text-faint">In {focus.cwd}</p>
            {error ? (
              <p role="alert" className="text-ui text-negative">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={!path.trim() || saving}
              className="pressable self-end rounded-md border border-hairline px-3 py-2 text-ui hover:bg-fill-hover disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save plan"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
