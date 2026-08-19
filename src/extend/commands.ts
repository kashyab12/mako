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

export function keysFor(
  command: DeskCommand,
  overrides: Readonly<Record<string, string>>
): string | undefined {
  return overrides[command.id] ?? command.keys
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
  const wantsMeta = wants.has("meta") || (isMac && wants.has("mod"))
  const wantsControl = wants.has("ctrl") || (!isMac && wants.has("mod"))
  if (wantsMeta !== event.metaKey) return false
  if (wantsControl !== event.ctrlKey) return false
  if (wants.has("shift") !== event.shiftKey) return false
  if (wants.has("alt") !== event.altKey) return false
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
  { character: "space", code: "Space" },
]

export function chordFromEvent(event: KeyboardEvent): string | null {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return null
  const physical = PHYSICAL_KEYS.find(({ code }) => code === event.code)?.character
  const key =
    physical ??
    (/^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : /^Digit[0-9]$/.test(event.code)
        ? event.code.slice(5)
        : event.key.toLowerCase())
  if (!key || key === "dead") return null
  const modifiers: string[] = []
  if (event.metaKey) modifiers.push(isMac ? "mod" : "meta")
  if (event.ctrlKey) modifiers.push(isMac ? "ctrl" : "mod")
  if (event.shiftKey) modifiers.push("shift")
  if (event.altKey) modifiers.push("alt")
  return [...modifiers, key].join("+")
}

/** Render a chord for display: "mod+k" → "⌘K" on macOS, "Ctrl K" elsewhere. */
export function formatChord(chord?: string): string[] {
  if (!chord) return []
  return chord.split("+").map((part) => {
    switch (part) {
      case "mod":
        return isMac ? "⌘" : "Ctrl"
      case "meta":
        return isMac ? "⌘" : "Meta"
      case "ctrl":
        return isMac ? "⌃" : "Ctrl"
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
      case "space":
        return "Space"
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
