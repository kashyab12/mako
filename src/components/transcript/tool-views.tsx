import { createElement, type ComponentType } from "react"
import { type ToolViewProps } from "@/extend/slots"
import { Output } from "@/components/transcript/tool-row"
import { argAt, editsOf } from "@/lib/tools"
import { cn } from "@/lib/utils"
import {
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderTreeIcon,
  GlobeIcon,
  MonitorCogIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react"

/** Icon by tool name, so the transcript is scannable without reading labels. */
const ICONS = new Map([
  ["bash", SquareTerminalIcon],
  ["edit", FilePenLineIcon],
  ["multiedit", FilePenLineIcon],
  ["write", FilePlusIcon],
  ["read", FileTextIcon],
  ["grep", SearchIcon],
  ["find", SearchIcon],
  ["ls", FolderTreeIcon],
  ["webfetch", GlobeIcon],
  ["websearch", GlobeIcon],
])

/**
 * Resolves a tool's glyph — a registered view's override first, then the
 * built-in table, then the generic wrench. Rendering it through a component
 * (rather than picking a component type at the call site) keeps the element
 * type stable across renders.
 */
export function ToolGlyph({
  name,
  override,
  className,
}: {
  name: string
  override?: ComponentType<{ className?: string }>
  className?: string
}) {
  const normalized = name.toLowerCase()
  const Glyph =
    override ??
    (normalized.startsWith("mako_macos_")
      ? MonitorCogIcon
      : normalized.startsWith("browser_")
        ? GlobeIcon
        : ICONS.get(normalized)) ??
    WrenchIcon
  return createElement(Glyph, { className })
}

/* ------------------------------------------------------------------ */
/* diff rendering                                                      */
/* ------------------------------------------------------------------ */

interface DiffLine {
  kind: "context" | "add" | "remove"
  text: string
}

/**
 * Line diff by common prefix/suffix trimming. It is O(n) instead of an LCS,
 * which is exactly right here: an edit's old and new text already share their
 * head and tail, and the transcript only needs to show what moved.
 */
function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n")
  const right = after.split("\n")

  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1

  let tail = 0
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1
  }

  const lines: DiffLine[] = []
  const context = 2
  for (let i = Math.max(0, head - context); i < head; i += 1) {
    lines.push({ kind: "context", text: left[i] })
  }
  for (let i = head; i < left.length - tail; i += 1) {
    lines.push({ kind: "remove", text: left[i] })
  }
  for (let i = head; i < right.length - tail; i += 1) {
    lines.push({ kind: "add", text: right[i] })
  }
  for (let i = left.length - tail; i < Math.min(left.length, left.length - tail + context); i += 1) {
    lines.push({ kind: "context", text: left[i] })
  }
  return lines
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="overflow-x-auto font-mono text-ui leading-[1.6]">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "flex gap-2 px-2.5",
            line.kind === "add" && "bg-added/10 text-added",
            line.kind === "remove" && "bg-removed/10 text-removed",
            line.kind === "context" && "text-faint"
          )}
        >
          <span className="w-2 shrink-0 select-none opacity-60">
            {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
          </span>
          <span className="whitespace-pre">{line.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* built-in views                                                      */
/* ------------------------------------------------------------------ */

export function EditBody({ call }: ToolViewProps) {
  const edits = editsOf(call)
  if (edits.length === 0) return <Output text={call.result ?? ""} />
  return (
    <div className="divide-y divide-hairline py-1">
      {edits.map((edit, index) => (
        <div key={index} className="py-1.5">
          <DiffBlock lines={diffLines(edit.oldText, edit.newText)} />
        </div>
      ))}
    </div>
  )
}

export function WriteBody({ call }: ToolViewProps) {
  const content = argAt(call.arguments, "content") ?? ""
  return (
    <div className="py-1">
      <DiffBlock
        lines={content.split("\n").map((text) => ({ kind: "add" as const, text }))}
      />
    </div>
  )
}

export function BashBody({ call }: ToolViewProps) {
  const command = argAt(call.arguments, "command") ?? ""
  return (
    <div className="space-y-1.5 px-2.5 py-2">
      <div className="flex gap-2 font-mono text-ui text-foreground/90">
        <span className="shrink-0 text-muted-foreground select-none">$</span>
        <span className="whitespace-pre-wrap">{command}</span>
      </div>
      {call.result ? (
        <Output text={call.result} isError={call.isError} />
      ) : (
        <p className="shimmer text-ui">running…</p>
      )}
    </div>
  )
}

