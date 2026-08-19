import { useCallback, useEffect, useState } from "react"
import { useInspectorPanels } from "@/extend/slots"
import { setPref, usePrefs, type InspectorTab } from "@/state/prefs"
import { useSession } from "@/state/session"
import { cn } from "@/lib/utils"

const PERSISTED_TABS = {
  changes: true,
  context: true,
  history: true,
} satisfies Record<InspectorTab, boolean>

function isPersistedTab(id: string): id is InspectorTab {
  return Object.hasOwn(PERSISTED_TABS, id)
}

/**
 * A tab host whose tabs come from a registry, so a plugin contributes a whole
 * panel with one call instead of forking this file. The built-ins are
 * registered in `desk/builtins`, on the same footing as anything else.
 */
export function Inspector() {
  const panels = useInspectorPanels()
  const persistedTab = usePrefs((prefs) => prefs.inspectorTab)
  const [extensionTab, setExtensionTab] = useState<{
    id: string
    persistedTab: InspectorTab
  }>()
  const selected = extensionTab?.persistedTab === persistedTab ? extensionTab.id : persistedTab
  // A removed plugin must not leave the inspector pointing at nothing.
  const active = panels.some((panel) => panel.id === selected) ? selected : panels[0]?.id
  const changeCount = useSession((state) => state.git?.files.length ?? 0)
  const selectTab = useCallback(
    (id: string) => {
      if (isPersistedTab(id)) {
        setExtensionTab(undefined)
        setPref("inspectorTab", id)
        return
      }
      setExtensionTab({ id, persistedTab })
    },
    [persistedTab]
  )

  useEffect(() => {
    const open = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        Object.prototype.toString.call(event.detail) !== "[object String]"
      ) {
        return
      }
      selectTab(String(event.detail))
    }
    window.addEventListener("mako:inspector-panel", open)
    return () => window.removeEventListener("mako:inspector-panel", open)
  }, [selectTab])

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
              onClick={() => selectTab(panel.id)}
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
