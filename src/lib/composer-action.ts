export type ComposerActionKind = "send" | "queue" | "steer" | "stop"

export function composerTurnRunning({
  builtinRunning,
  livePresent,
  liveRunning,
  liveThreadPath,
  viewingPath,
  viewingRunning,
}: {
  builtinRunning: boolean
  livePresent: boolean
  liveRunning: boolean
  liveThreadPath?: string
  viewingPath?: string
  viewingRunning: boolean
}): boolean {
  if (viewingPath && (!livePresent || viewingPath !== liveThreadPath))
    return viewingRunning
  if (livePresent) return liveRunning
  return builtinRunning
}

export function composerActionKind({
  running,
  hasContent,
  steer = false,
}: {
  running: boolean
  hasContent: boolean
  /** The running turn takes messages now and the user prefers that over queueing. */
  steer?: boolean
}): ComposerActionKind {
  if (!running) return "send"
  if (!hasContent) return "stop"
  return steer ? "steer" : "queue"
}
