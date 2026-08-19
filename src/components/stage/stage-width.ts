/**
 * The stage never splits by percentage. A fraction grows the companion with
 * the monitor, which is exactly backwards: a diff needs a fixed readable
 * width and the conversation deserves everything left over. So the chat
 * reserves its minimum, the companion keeps a fixed width the user can drag,
 * and the clamp mediates when the window cannot afford both.
 */

export const CHAT_MIN = 450
export const COMPANION_MIN_DEFAULT = 380
/** The card gutters between and around the two cards. */
export const STAGE_GUTTERS = 24

export function clampCompanionWidth(input: {
  width: number
  /** The stage row's measured width; undefined before the first measure. */
  available: number | undefined
  min: number
}): number {
  const { width, available, min } = input
  // Before the ResizeObserver has spoken, trust the stored width — clamping
  // against a guess would snap the pane on the first frame.
  if (available === undefined) return Math.max(width, min)
  const most = available - CHAT_MIN - STAGE_GUTTERS
  return Math.min(Math.max(width, min), Math.max(most, min))
}

/** Whether a beside split physically fits; below this the companion covers. */
export function fitsBeside(available: number | undefined, min: number): boolean {
  if (available === undefined) return true
  return available >= CHAT_MIN + min + STAGE_GUTTERS
}
