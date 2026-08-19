import { Registry, useRegistry } from "@/extend/registry"

/**
 * Every action the desk can perform is a command. The palette, the keyboard
 * layer, and menus all read this one table — so adding a capability once makes
 * it reachable three ways, and an extension gets the same reach as core.
 */

export type CommandSection = "Session" | "Model" | "View" | "Workspace" | "Agent" | "Extension"

export interface DeskCommand {
  id: string
  title: string
  section: CommandSection
  /** Chord in the "mod+k" / "shift+alt+t" form. `mod` maps to ⌘ on macOS. */
  keys?: string
  hint?: string
  /** Extra words that should match in the palette but are not displayed. */
  keywords?: string
  when?: () => boolean
  run: () => void | Promise<void>
}

export const commands = new Registry<DeskCommand>()

export function registerCommand(command: DeskCommand) {
  return commands.register(command.id, command)
}

export function registerCommands(list: DeskCommand[]) {
  const disposers = list.map(registerCommand)
  return () => disposers.forEach((dispose) => dispose())
}

export function runCommand(id: string) {
  const command = commands.get(id)
  if (!command || command.when?.() === false) return false
  void command.run()
  return true
}

export function useCommands(): DeskCommand[] {
  return useRegistry(commands).list()
}

/* ------------------------------------------------------------------ */
/* keyboard                                                            */
/* ------------------------------------------------------------------ */

const isMac =
  globalThis.navigator?.platform.toLowerCase().includes("mac") ?? false

export function matchesChord(event: KeyboardEvent, chord: string): boolean {
  const parts = chord.toLowerCase().split("+")
  const key = parts.at(-1) ?? ""
  const wants = new Set(parts.slice(0, -1))
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (wants.has("mod") !== mod) return false
  if (wants.has("shift") !== event.shiftKey) return false
  if (wants.has("alt") !== event.altKey) return false
  if (!wants.has("mod") && (isMac ? event.ctrlKey : event.metaKey)) return false
  const pressed = event.key.toLowerCase()
  if (pressed === key) return true
  // Option-modified keys report their composed character on macOS, and shifted
  // punctuation reports the shifted glyph — "]" arrives as "}". Matching the
  // physical key covers both.
  return (
    event.code.toLowerCase() === `key${key}` ||
    event.code.toLowerCase() === `digit${key}` ||
    event.code ===
      PHYSICAL_KEYS.find(({ character }) => character === key)?.code
  )
}

interface PhysicalKey {
  character: string
  code: string
}

/** Physical keys whose reported character changes under a modifier. */
const PHYSICAL_KEYS: PhysicalKey[] = [
  { character: "[", code: "BracketLeft" },
  { character: "]", code: "BracketRight" },
  { character: "\\", code: "Backslash" },
  { character: "/", code: "Slash" },
  { character: ".", code: "Period" },
  { character: ",", code: "Comma" },
  { character: ";", code: "Semicolon" },
  { character: "'", code: "Quote" },
  { character: "-", code: "Minus" },
  { character: "=", code: "Equal" },
  { character: "`", code: "Backquote" },
]

/** Render a chord for display: "mod+k" → "⌘K" on macOS, "Ctrl K" elsewhere. */
export function formatChord(chord?: string): string[] {
  if (!chord) return []
  return chord.split("+").map((part) => {
    switch (part) {
      case "mod":
        return isMac ? "⌘" : "Ctrl"
      case "shift":
        return isMac ? "⇧" : "Shift"
      case "alt":
        return isMac ? "⌥" : "Alt"
      case "enter":
        return "↩"
      case "escape":
        return "Esc"
      case "backspace":
        return "⌫"
      case "arrowup":
        return "↑"
      case "arrowdown":
        return "↓"
      case ".":
        return "."
      case ",":
        return ","
      default:
        return part.toUpperCase()
    }
  })
}

/** True when focus is inside a text field and the chord has no modifier. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}
