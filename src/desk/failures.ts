import { getPi, hasBridge } from "@/lib/bridge"

/**
 * Errors the error boundary never sees.
 *
 * A boundary only catches what throws during render. Everything else — a
 * listener that throws, a promise nobody caught, a failed dynamic import — goes
 * to `window.onerror` and vanishes into a console. Those are the ones that
 * leave the app subtly wrong rather than obviously broken, which makes them
 * the ones most worth writing down.
 *
 * Recorded, not surfaced. The app is still standing after these, and a toast
 * per unhandled rejection would be noise on top of a bug.
 */

/** One report per distinct message, so a failure in a loop cannot fill the disk. */
const seen = new Set<string>()
const LIMIT = 25

function report(
  kind: "renderer-error" | "renderer-rejection",
  message: string,
  stack?: string,
  source?: string
) {
  if (!hasBridge() || !message) return
  const key = `${kind}:${message}:${source ?? ""}`
  if (seen.has(key) || seen.size >= LIMIT) return
  seen.add(key)
  void getPi()
    .reportCrash(kind, { message, stack, source })
    .catch(() => {
      // Reporting a failure must never itself fail loudly.
    })
}

export function watchForFailures() {
  window.addEventListener("error", (event) => {
    const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined
    report("renderer-error", event.message, event.error?.stack, where)
  })

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as unknown
    if (reason instanceof Error) {
      report("renderer-rejection", reason.message, reason.stack)
      return
    }
    report("renderer-rejection", typeof reason === "string" ? reason : "Unhandled rejection")
  })
}
