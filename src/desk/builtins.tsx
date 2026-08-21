import {
  BotIcon,
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
import { TerminalDockToggle } from "@/components/stage/terminal-dock-toggle"
import {
  BashBody,
  EditBody,
  SubagentBody,
  WriteBody,
} from "@/components/transcript/tool-views"
import {
  argAt,
  countLines,
  editsOf,
  primaryArgument,
  SUBAGENT_TOOLS,
} from "@/lib/tools"
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
    registerSlot("terminal-dock", "composer.trailing", TerminalDockToggle, -10),

    ...["bash", "Bash", "shell", "Shell", "exec_command"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => argAt(call.arguments, "command") ?? "",
        body: BashBody,
      })
    ),
    ...["edit", "Edit", "multiedit", "MultiEdit"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => {
          const edits = editsOf(call)
          const path = primaryArgument(call.arguments)
          return edits.length > 1 ? `${path} · ${edits.length} edits` : path
        },
        body: EditBody,
      })
    ),
    ...["write", "Write"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          `${primaryArgument(call.arguments)} · ${countLines(argAt(call.arguments, "content"))} lines`,
        body: WriteBody,
      })
    ),
    ...["read", "Read", "ReadFile", "read_file"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => {
          const path = primaryArgument(call.arguments)
          return path ? fileName(path) : ""
        },
      })
    ),
    ...["grep", "Grep", "rg", "find", "Glob", "glob"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => {
          const query =
            argAt(call.arguments, "pattern") ??
            argAt(call.arguments, "query") ??
            argAt(call.arguments, "glob_pattern")
          const path = primaryArgument(call.arguments)
          return [query, path].filter(Boolean).join(" · ")
        },
      })
    ),
    ...["ls", "list_files"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => primaryArgument(call.arguments) || ".",
      })
    ),
    ...["webfetch", "WebFetch", "web_search", "WebSearch"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) => primaryArgument(call.arguments),
      })
    ),
    ...["Skill", "skill"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "skill") ??
          argAt(call.arguments, "name") ??
          primaryArgument(call.arguments),
      })
    ),
    ...[
      "TaskCreate",
      "TaskUpdate",
      "TodoWrite",
      "CreatePlan",
    ].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "subject") ??
          argAt(call.arguments, "title") ??
          argAt(call.arguments, "description") ??
          "Plan",
      })
    ),
    ...["AskQuestion", "AskUserQuestion"].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "question") ??
          argAt(call.arguments, "prompt") ??
          "Question",
      })
    ),
    ...["ScheduleWakeup", "AwaitShell", "write_stdin", "ToolSearch"].map(
      (name) =>
        registerToolView(name, {
          summary: (call: ToolCall) => primaryArgument(call.arguments),
        })
    ),
    ...[
      "mako_macos_apps",
      "mako_macos_state",
      "mako_macos_see",
      "mako_macos_click",
      "mako_macos_key",
      "mako_macos_type",
      "mako_macos_script",
      "mako_macos_exec",
      "mako_preview_list",
      "mako_preview_state",
      "mako_preview_snapshot",
      "mako_preview_navigate",
      "mako_preview_click",
      "mako_preview_type",
      "mako_preview_press",
      "mako_preview_evaluate",
    ].map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "app") ?? primaryArgument(call.arguments),
      })
    ),
    ...SUBAGENT_TOOLS.map((name) =>
      registerToolView(name, {
        summary: (call: ToolCall) =>
          argAt(call.arguments, "description") ??
          argAt(call.arguments, "title") ??
          argAt(call.arguments, "role") ??
          argAt(call.arguments, "subagent_type") ??
          argAt(call.arguments, "agent_id") ??
          argAt(call.arguments, "target") ??
          argAt(call.arguments, "cell_id") ??
          "Background agent",
        body: SubagentBody,
        icon: BotIcon,
      })
    ),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
