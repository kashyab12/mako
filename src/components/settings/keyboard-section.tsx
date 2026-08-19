import { useState } from "react"
import { Action, Eyebrow, Keys } from "@/components/ui/kit"
import {
  chordFromEvent,
  formatChord,
  keysFor,
  useCommands,
  type DeskCommand,
} from "@/extend/commands"
import { setPref, usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"

export function KeyboardSection() {
  const commands = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)
  const [query, setQuery] = useState("")
  const [capturing, setCapturing] = useState<string>()
  const [candidate, setCandidate] = useState("")
  const term = query.trim().toLowerCase()
  const shown = commands.filter((command) =>
    term
      ? `${command.title} ${command.section} ${command.hint ?? ""}`
          .toLowerCase()
          .includes(term)
      : true
  )

  const save = (command: DeskCommand) => {
    const next = { ...keybindings }
    if (candidate === (command.keys ?? "")) delete next[command.id]
    else next[command.id] = candidate
    setPref("keybindings", next)
    setCapturing(undefined)
  }

  return (
    <section className="mb-5 last:mb-0">
      <Eyebrow className="px-0 pb-2">Keyboard shortcuts</Eyebrow>
      <div className="flex items-center gap-2 pb-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search commands"
          className="h-8 min-w-0 flex-1 rounded-md bg-surface px-2.5 text-[12px] text-foreground ring-1 ring-hairline placeholder:text-faint focus:ring-border focus:outline-none"
        />
        {Object.keys(keybindings).length > 0 ? (
          <Action tone="ghost" onClick={() => setPref("keybindings", {})}>
            Reset all
          </Action>
        ) : null}
      </div>
      <p className="pb-2 text-[11.5px] leading-relaxed text-faint">
        Click a shortcut, then press the new keys. Mako shortcuts take priority
        inside the terminal; unassigned terminal keys still go straight to the shell.
      </p>
      <div className="flex flex-col gap-0.5">
        {shown.map((command) => (
          <ShortcutRow
            key={command.id}
            command={command}
            commands={commands}
            keybindings={keybindings}
            capturing={capturing === command.id}
            candidate={candidate}
            onCapture={() => {
              setCandidate(keysFor(command, keybindings) ?? "")
              setCapturing(command.id)
            }}
            onCandidate={setCandidate}
            onCancel={() => setCapturing(undefined)}
            onSave={() => save(command)}
          />
        ))}
        {shown.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-faint">No commands match.</p>
        ) : null}
      </div>
    </section>
  )
}

function ShortcutRow({
  command,
  commands,
  keybindings,
  capturing,
  candidate,
  onCapture,
  onCandidate,
  onCancel,
  onSave,
}: {
  command: DeskCommand
  commands: DeskCommand[]
  keybindings: Readonly<Record<string, string>>
  capturing: boolean
  candidate: string
  onCapture: () => void
  onCandidate: (value: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  const current = keysFor(command, keybindings) ?? ""
  const chord = capturing ? candidate : current
  const conflicts = shortcutConflicts(command, chord, commands, keybindings)

  return (
    <div className="rounded-lg px-2.5 py-2 hover:bg-surface">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-foreground/90">
            {command.title}
          </span>
          <span className="block text-[10.5px] text-faint">
            {command.section}
            {keybindings[command.id] !== undefined && command.keys
              ? ` · default ${formatChord(command.keys).join("")}`
              : ""}
          </span>
        </span>
        {capturing ? (
          <button
            type="button"
            autoFocus
            aria-label={`Recording shortcut for ${command.title}`}
            data-keybinding-capture
            onKeyDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (event.key === "Escape") {
                onCancel()
                return
              }
              if (event.key === "Backspace" || event.key === "Delete") {
                onCandidate("")
                return
              }
              const next = chordFromEvent(event.nativeEvent)
              if (next) onCandidate(next)
            }}
            className="pressable flex h-7 min-w-28 items-center justify-center rounded-md bg-raised px-2 ring-1 ring-border"
          >
            {candidate ? (
              <Keys keys={formatChord(candidate)} />
            ) : (
              <span className="text-[10.5px] text-faint">Press keys</span>
            )}
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Change shortcut for ${command.title}`}
            onClick={onCapture}
            className="pressable flex h-7 min-w-20 items-center justify-center rounded-md px-2 hover:bg-raised"
          >
            {current ? (
              <Keys keys={formatChord(current)} />
            ) : (
              <span className="text-[10.5px] text-faint">None</span>
            )}
          </button>
        )}
      </div>
      {capturing ? (
        <div className="mt-1.5 flex items-center gap-2 pl-0.5">
          <span
            className={cn(
              "min-w-0 flex-1 text-[10.5px]",
              conflicts.length > 0 ? "text-caution" : "text-faint"
            )}
          >
            {conflicts.length > 0
              ? `Already used by ${conflicts.map((entry) => entry.title).join(", ")}`
              : candidate
                ? "Press Save to use this shortcut"
                : "Backspace removes the shortcut"}
          </span>
          <Action tone="ghost" onClick={onCancel}>
            Cancel
          </Action>
          <Action disabled={conflicts.length > 0} onClick={onSave}>
            Save
          </Action>
        </div>
      ) : conflicts.length > 0 ? (
        <p className="pt-1 text-[10.5px] text-caution">
          Conflicts with {conflicts.map((entry) => entry.title).join(", ")}
        </p>
      ) : null}
    </div>
  )
}

function shortcutConflicts(
  command: DeskCommand,
  chord: string,
  commands: DeskCommand[],
  keybindings: Readonly<Record<string, string>>
): DeskCommand[] {
  if (!chord) return []
  return commands.filter(
    (entry) =>
      entry.id !== command.id &&
      keysFor(entry, keybindings)?.toLowerCase() === chord.toLowerCase()
  )
}
