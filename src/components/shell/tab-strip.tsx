import { memo, useCallback, useEffect, useRef } from "react"
import { actions } from "@/state/session"
import { useTabs, type TabInfo } from "@/state/tabs"
import { formatChord } from "@/extend/commands"
import { cn } from "@/lib/utils"
import { PlusIcon, XIcon } from "lucide-react"

/**
 * The open conversations, as a strip.
 *
 * Hidden until there are two. One tab is not a choice, and a strip that draws
 * itself to say "you have one thing open" is chrome charging rent — the title
 * already names the conversation.
 *
 * Each tab shows whether its agent is still working, which is the entire
 * reason the strip is worth its height: a conversation you branched off keeps
 * running while you read the other one, and you need to be able to see that
 * without switching to it.
 */
export function TabStrip() {
  const tabs = useTabs((state) => state.tabs)
  const activeId = useTabs((state) => state.activeId)
  const scroller = useRef<HTMLDivElement>(null)

  // Keep the selected tab in view when it is chosen from a keyboard shortcut,
  // where nothing scrolled it into place on the way.
  useEffect(() => {
    const node = scroller.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeId])

  const select = useCallback((id: string) => void actions.switchTab(id), [])
  const close = useCallback((id: string) => void actions.closeTab(id), [])

  if (tabs.length < 2) return null

  return (
    <div className="flex h-[34px] shrink-0 items-stretch border-b border-hairline">
      <div
        ref={scroller}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => (
          <Tab key={tab.id} tab={tab} active={tab.id === activeId} onSelect={select} onClose={close} />
        ))}
      </div>
      <button
        type="button"
        title={`New tab · ${formatChord("mod+t")}`}
        onClick={() => void actions.openTab()}
        className={cn(
          "pressable flex w-9 shrink-0 items-center justify-center border-l border-hairline",
          "text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
        )}
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  )
}

const Tab = memo(function Tab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TabInfo
  active: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
}) {
  return (
    <div
      data-active={active}
      className={cn(
        "group relative flex h-full min-w-[128px] max-w-[240px] shrink-0 items-center",
        "border-r border-hairline pr-1 pl-2.5",
        // Colour only. Tabs are switched dozens of times an hour, so the change
        // has to land on the first frame — no movement, nothing to wait out.
        "transition-colors duration-100",
        active ? "bg-fill-selected text-foreground" : "text-faint hover:bg-fill-hover hover:text-muted-foreground"
      )}
    >

      <button
        type="button"
        onClick={() => onSelect(tab.id)}
        onAuxClick={(event) => {
          // Middle-click closes, as it does in every browser and editor.
          if (event.button === 1) onClose(tab.id)
        }}
        title={tab.title}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <Status tab={tab} />
        <span className="truncate text-[12px]">{tab.title}</span>
      </button>

      <button
        type="button"
        aria-label="Close tab"
        onClick={() => onClose(tab.id)}
        className={cn(
          "pressable flex size-5 shrink-0 items-center justify-center rounded",
          "text-faint opacity-0 transition-[opacity,color] duration-100",
          "group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
})

/**
 * The one thing a tab has to be able to say from across the window: is this
 * agent still going? Working pulses, finished-while-you-were-away is a steady
 * dot, and an idle tab shows nothing at all.
 */
function Status({ tab }: { tab: TabInfo }) {
  if (tab.working) {
    return (
      <span
        aria-label={tab.streaming ? "Responding" : "Working"}
        className="size-1.5 shrink-0 animate-live rounded-full bg-ember"
      />
    )
  }
  if (tab.unread) {
    return <span aria-label="Finished" className="size-1.5 shrink-0 rounded-full bg-foreground/45" />
  }
  return <span aria-hidden className="size-1.5 shrink-0" />
}
