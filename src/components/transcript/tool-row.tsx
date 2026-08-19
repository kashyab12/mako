import { memo, useState } from "react"
import { useToolView, type ToolCall } from "@/extend/slots"
import { primaryArgument } from "@/lib/tools"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import { ChevronRightIcon, CircleAlertIcon , CheckIcon, CopyIcon } from "lucide-react"
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
  const Body = view?.body

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border transition-colors duration-150",
        call.isError ? "border-negative/30 bg-negative/[0.04]" : "border-hairline bg-surface",
        open && "border-border"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-100 hover:bg-raised/60"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-faint transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        <ToolGlyph
          name={call.name}
          override={view?.icon}
          className={cn(
            "size-3.5 shrink-0",
            call.isError ? "text-negative" : call.pending ? "text-brand" : "text-faint"
          )}
        />
        <span className="shrink-0 text-[12px] font-medium text-foreground/90">
          {call.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{summary}</span>
        <Status call={call} />
      </button>

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

function Status({ call }: { call: ToolCall }) {
  if (call.pending) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-brand">
        <span className="size-1 animate-live rounded-full bg-brand" />
        running
      </span>
    )
  }
  if (call.isError) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-negative">
        <CircleAlertIcon className="size-3" />
        failed
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
          <pre className="rounded bg-raised px-2 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
        </CopyableBlock>
      ) : null}
      {call.result ? (
        <Output text={call.result} dense={dense} isError={call.isError} />
      ) : (
        <p className="shimmer text-[11.5px]">waiting for result…</p>
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
          "font-mono text-[11.5px] leading-[1.55] break-words whitespace-pre-wrap",
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
          className="mt-1 text-[11px] text-brand hover:underline"
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
          "absolute top-1 right-1 rounded-md bg-raised/90 p-1 ring-1 ring-hairline backdrop-blur-sm",
          "text-faint transition-opacity duration-100 hover:text-foreground",
          copied ? "opacity-100" : "opacity-0 group-hover/copyblock:opacity-100"
        )}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    </div>
  )
}
