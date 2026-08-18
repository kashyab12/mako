import { FilesIcon, GitCompareIcon, HistoryIcon, LayersIcon } from "lucide-react"
import {
  registerInspectorPanel,
  registerToolView,
  type ToolCall,
} from "@/extend/slots"
import { ChangesPanel } from "@/components/inspector/changes-lazy"
import { FileTree } from "@/components/rail/file-tree"
import { ContextPanel } from "@/components/inspector/context-panel"
import { HistoryPanel } from "@/components/inspector/history-panel"
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
    registerInspectorPanel({
      id: "changes",
      label: "Changes",
      icon: GitCompareIcon,
      render: ChangesPanel,
      order: 0,
    }),
    registerInspectorPanel({
      id: "context",
      label: "Context",
      icon: LayersIcon,
      render: ContextPanel,
      order: 1,
    }),
    registerInspectorPanel({
      id: "history",
      label: "History",
      icon: HistoryIcon,
      render: HistoryPanel,
      order: 2,
    }),
    registerInspectorPanel({
      id: "files",
      label: "Files",
      icon: FilesIcon,
      render: FileTree,
      order: 3,
    }),

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
