import { TerminalSquareIcon } from "lucide-react"
import { formatChord } from "@/extend/commands"
import { IconAction } from "@/components/ui/kit"
import { usePrefs } from "@/state/prefs"
import { stage, useStage } from "@/state/stage"
import { useTabs } from "@/state/tabs"

export function TerminalDockToggle() {
  const activeId = useTabs((state) => state.activeId)
  const open = useStage(
    (state) => state.byTab[activeId]?.dock === "terminal"
  )
  const keys = usePrefs(
    (prefs) => prefs.keybindings["view.terminal"] ?? "mod+j"
  )
  return (
    <IconAction
      label={open ? "Hide terminal" : "Show terminal"}
      keys={formatChord(keys)}
      side="top"
      size="xs"
      data-on={open}
      onClick={() => stage.toggleDock("terminal")}
    >
      <TerminalSquareIcon />
    </IconAction>
  )
}
