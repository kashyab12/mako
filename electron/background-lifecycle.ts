export interface BackgroundLifecycle {
  hasActiveWork(): boolean
  isRestarting(): boolean
  hide(): void
  cleanup(): void
}

export function handleQuit(
  event: { preventDefault(): void },
  lifecycle: BackgroundLifecycle
): void {
  if (!lifecycle.isRestarting() && lifecycle.hasActiveWork()) {
    event.preventDefault()
    lifecycle.hide()
    return
  }
  lifecycle.cleanup()
}
