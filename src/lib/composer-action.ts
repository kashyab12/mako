export type ComposerActionKind = "send" | "queue" | "stop"

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
}: {
  running: boolean
  hasContent: boolean
}): ComposerActionKind {
  if (!running) return "send"
  return hasContent ? "queue" : "stop"
}
