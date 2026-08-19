export interface KeyboardLayoutMapLike {
  get(code: string): string | undefined
  readonly size: number
}

declare global {
  interface Navigator {
    keyboard?: {
      getLayoutMap(): Promise<KeyboardLayoutMapLike>
    }
  }
}

const US_FINGERPRINT = new Map([
  ["KeyQ", "q"],
  ["KeyW", "w"],
  ["KeyA", "a"],
  ["KeyZ", "z"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Backquote", "`"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
])

export function isUsKeyboardLayout(
  layout: KeyboardLayoutMapLike | null
): boolean {
  if (!layout || layout.size === 0) return false
  for (const [code, expected] of US_FINGERPRINT) {
    if (layout.get(code) !== expected) return false
  }
  return true
}

export async function detectMacOptionIsMeta(): Promise<boolean> {
  if (!navigator.userAgent.includes("Mac")) return false
  const keyboard = navigator.keyboard
  if (!keyboard) return false
  try {
    return isUsKeyboardLayout(await keyboard.getLayoutMap())
  } catch {
    return false
  }
}
