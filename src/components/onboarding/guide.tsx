import { useEffect, useMemo, useState } from "react"
import {
  formatChord,
  keysFor,
  useCommands,
  type DeskCommand,
} from "@/extend/commands"
import { usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { XIcon } from "lucide-react"

/**
 * What is where, and what the keys do.
 *
 * The alternative — a scripted tour with coach marks — was rejected on
 * purpose. A tour arrives before you have a reason to care, blocks the thing
 * it is describing, and is dismissed once and never seen again, which means
 * the one moment it could help (three weeks in, wondering what a panel is) is
 * the moment it is gone.
 *
 * This is the opposite: available whenever, on one key, showing everything at
 * once. The shortcut list is **generated from the command registry**, so it
 * cannot drift from what the app actually does — including anything a plugin
 * has registered. A hand-maintained list of keys is wrong within a month.
 */

interface Region {
  name: string
  commandId: string
  what: string
}

const REGIONS: Region[] = [
  {
    name: "Sidebar",
    commandId: "view.toggle-rail",
    what: "Your conversations in this project, or the project's files. The header wears the project's logo.",
  },
  {
    name: "Tabs",
    commandId: "tab.new",
    what: "Several agents at once. A background tab keeps working and says so with a dot.",
  },
  {
    name: "Conversation",
    commandId: "session.focus-composer",
    what: "Ask here. While a turn runs, Enter steers it and ⌘↩ queues a follow-up.",
  },
  {
    name: "Inspector",
    commandId: "view.toggle-inspector",
    what: "What changed, what the agent has in context, and every turn as a point you can go back to.",
  },
  {
    name: "Preview",
    commandId: "view.preview",
    what: "The dev server, beside the conversation, plus everything listening on this machine.",
  },
]

export function Guide() {
  const [open, setOpen] = useState(false)
  const commands = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener("mako:guide", show)
    return () => window.removeEventListener("mako:guide", show)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  /** Only commands with a chord: this is a key map, not a command list. */
  const sections = useMemo(() => {
    const grouped = new Map<string, Array<{ title: string; keys: string[] }>>()
    for (const command of commands) {
      const keys = keysFor(command, keybindings)
      if (!keys) continue
      const list = grouped.get(command.section) ?? []
      list.push({ title: command.title, keys: formatChord(keys) })
      grouped.set(command.section, list)
    }
    return [...grouped.entries()]
  }, [commands, keybindings])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="What is where"
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 pt-[8vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div className="overlay-panel flex max-h-[80vh] w-full max-w-content flex-col overflow-hidden rounded-xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3.5">
          <span className="text-[13px] font-medium">What is where</span>
          <span className="text-[11.5px] text-faint">and every key that does something</span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="pressable ml-auto rounded p-1 text-faint hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3.5">
          <div className="flex flex-col gap-1.5">
            {REGIONS.map((region) => (
              <div key={region.name} className="flex items-start gap-3 rounded-lg bg-surface px-3 py-2">
                <span className="w-24 shrink-0 text-[12px] font-medium">{region.name}</span>
                <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-muted-foreground">
                  {region.what}
                </span>
                <Chord keys={regionKeys(region, commands, keybindings)} />
              </div>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
            {sections.map(([section, entries]) => (
              <div key={section}>
                <p className="pb-1 text-[11px] text-faint">{section}</p>
                {entries.map((entry) => (
                  <div key={entry.title} className="flex items-baseline gap-2 py-[3px]">
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85">
                      {entry.title}
                    </span>
                    <span className="flex shrink-0 gap-0.5">
                      {entry.keys.map((key, index) => (
                        <kbd
                          key={`${key}-${index}`}
                          className="rounded border border-hairline bg-raised px-1 text-[10px] text-faint"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function regionKeys(
  region: Region,
  commands: DeskCommand[],
  keybindings: Readonly<Record<string, string>>
): string | undefined {
  const command = commands.find((entry) => entry.id === region.commandId)
  return command ? keysFor(command, keybindings) : undefined
}

function Chord({ keys }: { keys?: string }) {
  if (!keys) return null
  return (
    <span className="flex shrink-0 gap-0.5">
      {formatChord(keys).map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className={cn("rounded border border-hairline bg-raised px-1 text-[10px] text-faint")}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
