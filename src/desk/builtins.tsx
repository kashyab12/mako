import {
  FilesIcon,
  GitCompareIcon,
  HistoryIcon,
  LayersIcon,
  MonitorIcon,
  TerminalSquareIcon,
} from "lucide-react"
import { registerSlot, registerToolView, type ToolCall } from "@/extend/slots"
import { registerSurface } from "@/extend/surfaces"
import { IdentityBadge } from "@/components/identity/identity-badge"
import { IdentityRow } from "@/components/identity/identity-row"
import { ChangesPanel } from "@/components/inspector/changes-lazy"
import { FileTree } from "@/components/rail/file-tree"
import { ContextPanel } from "@/components/inspector/context-panel"
import { HistoryPanel } from "@/components/inspector/history-panel"
import { TerminalPanel } from "@/components/inspector/terminal-lazy"
import { PreviewPane } from "@/components/preview/preview-pane"
import { BashBody, EditBody, WriteBody } from "@/components/transcript/tool-views"
import { argAt, countLines, editsOf, primaryArgument } from "@/lib/tools"
import { fileName } from "@/lib/format"

/**
 * The desk's own contributions, registered through exactly the same public
 * API an extension would use. Nothing here is privileged: an extension can
 * re-register any of these ids and take the surface over.
 */

export function installBuiltins(): () => void {
  const disposers = [
    registerSurface({
      id: "changes",
      label: "Changes",
      icon: GitCompareIcon,
      render: ChangesPanel,
      order: 0,
      minWidth: 400,
    }),
    registerSurface({
      id: "context",
      label: "Context",
      icon: LayersIcon,
      render: ContextPanel,
      order: 1,
    }),
    registerSurface({
      id: "history",
      label: "History",
      icon: HistoryIcon,
      render: HistoryPanel,
      order: 2,
    }),
    registerSurface({
      id: "files",
      label: "Files",
      icon: FilesIcon,
      render: FileTree,
      order: 3,
    }),
    registerSurface({
      id: "terminal",
      label: "Terminal",
      icon: TerminalSquareIcon,
      render: TerminalPanel,
      order: 4,
      placement: "bottom",
      minHeight: 180,
    }),
    registerSurface({
      id: "preview",
      label: "Preview",
      icon: MonitorIcon,
      render: PreviewPane,
      order: 5,
      minWidth: 460,
    }),

    // Identity, through the same slots a plugin would use.
    registerSlot("identity", "titlebar.trailing", IdentityBadge, -10),
    registerSlot("identity", "rail.footer", IdentityRow, -10),

    registerToolView("bash", {
      summary: (call: ToolCall) => argAt(call.arguments, "command") ?? "",
      body: BashBody,
    }),
    registerToolView("edit", {
      summary: (call: ToolCall) => {
        const edits = editsOf(call)
        const path = primaryArgument(call.arguments)
        return edits.length > 1 ? `${path} · ${edits.length} edits` : path
      },
      body: EditBody,
    }),
    registerToolView("multiedit", {
      summary: (call: ToolCall) => primaryArgument(call.arguments),
      body: EditBody,
    }),
    registerToolView("write", {
      summary: (call: ToolCall) =>
        `${primaryArgument(call.arguments)} · ${countLines(argAt(call.arguments, "content"))} lines`,
      body: WriteBody,
    }),
    registerToolView("read", {
      summary: (call: ToolCall) => {
        const path = primaryArgument(call.arguments)
        return path ? fileName(path) : ""
      },
    }),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
