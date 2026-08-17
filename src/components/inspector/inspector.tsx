import { useEffect } from "react"
import { useInspectorPanels } from "@/extend/slots"
import { setPref, usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"

/**
 * A tab host whose tabs come from a registry, so a plugin contributes a whole
 * panel with one call instead of forking this file. The built-ins are
 * registered in `desk/builtins`, on the same footing as anything else.
 */
export function Inspector() {
  const panels = useInspectorPanels()
  const active = usePrefs((prefs) => prefs.inspectorTab)
  const changeCount = useSession((state) => state.git?.files.length ?? 0)

  // A removed plugin must not leave the inspector pointing at nothing.
  useEffect(() => {
    if (panels.length && !panels.some((panel) => panel.id === active)) {
      setPref("inspectorTab", panels[0].id as never)
    }
  }, [active, panels])

  const Current = panels.find((panel) => panel.id === active)?.render

  return (
    <section className="flex h-full min-h-0 flex-col">
      <nav className="flex h-9 shrink-0 items-center gap-0.5 border-b border-hairline px-1.5">
        {panels.map((panel) => {
          const Icon = panel.icon
          const on = panel.id === active
          return (
            <button
              key={panel.id}
              type="button"
              onClick={() => setPref("inspectorTab", panel.id as never)}
              className={cn(
                "pressable relative flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium",
                "[transition:transform_var(--duration-press)_var(--ease-out),color_120ms_ease,background-color_120ms_ease]",
                on ? "bg-raised text-foreground" : "text-faint hover:text-muted-foreground"
              )}
            >
              {Icon ? <Icon className="size-3.5" /> : null}
              {panel.label}
              {panel.id === "changes" && changeCount > 0 ? (
                <span className="tabular ml-0.5 rounded bg-caution/15 px-1 text-[10px] text-caution">
                  {changeCount}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>
      <div className="min-h-0 flex-1">{Current ? <Current /> : null}</div>
    </section>
  )
}
