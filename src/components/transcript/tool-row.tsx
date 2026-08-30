import { memo, useState, type ComponentType } from "react"
import { useToolView, type ToolCall } from "@/extend/slots"
import { primaryArgument, toolLabel } from "@/lib/tools"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import { viewer } from "@/state/viewer"
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react"
import { ToolGlyph } from "@/components/transcript/tool-views"

/**
 * One tool invocation, collapsed to a single line by default. The row is the
 * transcript's rhythm section — it has to stay quiet at a glance and be
 * complete when opened.
 */
export const ToolRow = memo(function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const dense = usePrefs((prefs) => prefs.denseTools)
  const view = useToolView(call.name)

  const summary = view?.summary?.(call) ?? primaryArgument(call.arguments)
  const openPath = view?.openPath?.(call)
  const Body = view?.body

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border transition-colors duration-150",
        call.isError ? "border-negative/30 bg-negative/[0.04]" : "border-hairline bg-surface",
        open && "border-border"
      )}
    >
      <div className="group/tool flex items-center">
        <button
          type="button"
          data-open={open || undefined}
          data-pending={call.pending || undefined}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover"
        >
          <LeadSlot call={call} open={open} icon={view?.icon} />
          <span className="shrink-0 text-ui font-medium text-foreground/90">
            {toolLabel(call.name)}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-ui text-faint">{summary}</span>
          <Status call={call} />
        </button>
        {openPath ? (
          <button
            type="button"
            title={`Open ${openPath}`}
            aria-label={`Open ${openPath}`}
            onClick={() => void viewer.open(openPath)}
            className="pressable mr-1 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover/tool:opacity-100 focus:opacity-100 hover:text-foreground"
          >
            <FileTextIcon className="size-3" />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="border-t border-hairline">
          {Body ? (
            <Body call={call} expanded />
          ) : (
            <DefaultBody call={call} dense={dense} />
          )}
        </div>
      ) : null}
    </div>
  )
})

/**
 * One leading slot, three states: a spinner while the tool runs, its glyph
 * at rest, and the chevron whenever the pointer is near or the row is open.
 * The three are stacked and crossfaded with CSS alone — no state, no
 * re-render per token, and the row never shifts because the slot is one
 * fixed square.
 */
function LeadSlot({
  call,
  open,
  icon,
}: {
  call: ToolCall
  open: boolean
  icon?: ComponentType<{ className?: string }>
}) {
  const layer =
    "absolute inset-0 m-auto [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  return (
    <span className="relative size-3.5 shrink-0">
      <Loader2Icon
        className={cn(
          layer,
          "size-3.5 animate-spin text-foreground/80",
          call.pending ? "opacity-100" : "opacity-0"
        )}
      />
      <ToolGlyph
        name={call.name}
        override={icon}
        className={cn(
          layer,
          "size-3.5",
          call.isError ? "text-negative" : "text-faint",
          call.pending
            ? "opacity-0"
            : open
              ? "opacity-0"
              : "opacity-100 group-hover/tool:opacity-0"
        )}
      />
      <ChevronRightIcon
        className={cn(
          layer,
          "size-3.5 text-faint",
          open
            ? "rotate-90 opacity-100"
            : call.pending
              ? "opacity-0"
              : "opacity-0 group-hover/tool:opacity-100"
        )}
      />
    </span>
  )
}

function Status({ call }: { call: ToolCall }) {
  if (call.pending) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-ember">
        <span className="size-1 animate-live rounded-full bg-ember" />
        running
      </span>
    )
  }
  if (call.isError) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-negative">
        <CircleAlertIcon className="size-3" />
        failed
      </span>
    )
  }
  if (call.isCanceled) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-label text-faint">
        <XIcon className="size-3" />
        canceled
      </span>
    )
  }
  return null
}

function parseArgumentEntries(value: ToolCall["arguments"]) {
  return Object.entries(Object(value))
}

function DefaultBody({ call, dense }: { call: ToolCall; dense: boolean }) {
  const args = parseArgumentEntries(call.arguments).length > 0

  return (
    <div className="space-y-2 px-2.5 py-2">
      {args ? (
        <CopyableBlock label="input" text={JSON.stringify(call.arguments, null, 2)}>
          <pre className="rounded bg-raised px-2 py-1.5 font-mono text-label leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
        </CopyableBlock>
      ) : null}
      {call.isCanceled ? (
        <p className="text-ui text-faint">canceled</p>
      ) : call.result ? (
        <Output text={call.result} dense={dense} isError={call.isError} />
      ) : (
        <p className="shimmer text-ui">waiting for result…</p>
      )}
    </div>
  )
}

const CLAMP = 12_000

export function Output({
  text,
  dense,
  isError,
}: {
  text: string
  dense?: boolean
  isError?: boolean
}) {
  const [full, setFull] = useState(false)
  const clipped = !full && text.length > CLAMP

  return (
    <CopyableBlock label="output" text={text}>
      <pre
        className={cn(
          "font-mono text-ui leading-[1.55] break-words whitespace-pre-wrap",
          dense ? "max-h-40 overflow-y-auto" : "max-h-[26rem] overflow-y-auto",
          isError ? "text-negative/90" : "text-muted-foreground"
        )}
      >
        {clipped ? `${text.slice(0, CLAMP)}\n…` : text}
      </pre>
      {clipped ? (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="mt-1 text-label text-muted-foreground hover:underline"
        >
          Show all {text.length.toLocaleString()} characters
        </button>
      ) : null}
    </CopyableBlock>
  )
}

/**
 * A block whose contents can leave. The copy affordance appears on hover in
 * the block's own corner — input and output each copy independently, whole
 * and unclipped, because "copy the answer" and "copy the command that
 * produced it" are different needs.
 */
function CopyableBlock({
  label,
  text,
  children,
}: {
  label: string
  text: string
  children: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group/copyblock relative">
      {children}
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
        className={cn(
          "absolute top-1 right-1 rounded-md bg-raised p-1 ring-1 ring-hairline backdrop-blur-sm",
          "text-faint transition-opacity duration-100 hover:text-foreground",
          copied ? "opacity-100" : "opacity-0 group-hover/copyblock:opacity-100"
        )}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    </div>
  )
}
