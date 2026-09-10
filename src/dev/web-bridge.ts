import {
  createMakoBridge,
  RuntimeInfoSchema,
  type RuntimeInfo,
  type HostEvent,
  type TerminalEvent,
} from "../../electron/shared.ts"

type WebEvent =
  | { channel: "ready"; runtime?: RuntimeInfo }
  | { channel: "event"; payload: HostEvent }
  | { channel: "terminal"; payload: TerminalEvent }

/** Vite forwards only same-origin requests to the actual host's private socket. */
export async function installWebBridge(): Promise<void> {
  if (import.meta.env.MAKO_SHARED_RUNTIME === true) {
    const url = new URL(location.href)
    url.searchParams.set("runtime", "shared")
    if (import.meta.env.MAKO_CLIENT_PROFILE) url.searchParams.set("profile", import.meta.env.MAKO_CLIENT_PROFILE)
    history.replaceState(null, "", url)
  }
  const events = new Set<(event: HostEvent) => void>()
  const terminals = new Set<(event: TerminalEvent) => void>()
  let connected = false
  let seen = false
  let stopped = false
  let supported: ReadonlySet<string> | null = null
  const clientId = crypto.randomUUID()
  const response = await fetch("/__mako/events", {
    method: "POST",
    headers: { "x-mako-client": "web", "x-mako-window": clientId },
  })
  if (!response.ok || !response.body)
    throw new Error(
      "The real Mako host is unavailable. Start it with npm run web."
    )
  let reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ""
  const dispatch = (line: string) => {
    if (!line.trim()) return
    // Same typed producer as Electron IPC; only the authenticated local host writes this stream.
    const event: WebEvent = JSON.parse(line)
    if (event.channel === "ready") {
      if (event.runtime || import.meta.env.MAKO_SHARED_RUNTIME === true) supported = new Set(RuntimeInfoSchema.parse(event.runtime).methods)
      connected = true
      if (seen) for (const listener of events) listener({ type: "host-reconnected" })
      seen = true
    } else if (event.channel === "event") {
      for (const listener of events) listener(event.payload)
    } else {
      for (const listener of terminals) listener(event.payload)
    }
  }
  const consume = (chunk: string) => {
    pending += chunk
    if (pending.length > 32 * 1024 * 1024)
      throw new Error("Mako host event exceeds the web transport limit")
    let newline = pending.indexOf("\n")
    while (newline >= 0) {
      dispatch(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }
  }
  while (!connected) {
    const chunk = await reader.read()
    if (chunk.done)
      throw new Error("Mako host closed before the web desk was ready")
    consume(chunk.value)
  }
  window.mako = createMakoBridge({
    async invoke(channel, ...args) {
      if (channel === "mako:open-preview-window") {
        const url = new URL(location.href)
        url.searchParams.set("preview", crypto.randomUUID())
        window.open(url.href, "_blank", "noopener")
        return
      }
      if (!connected)
        throw new Error(
          "The shared host is reconnecting. Your message has not been resent."
        )
      if (supported && !supported.has(channel)) throw new Error("This action requires a newer shared host. Existing agents have not been restarted.")
      const reply = await fetch("/__mako/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mako-client": "web", "x-mako-window": clientId },
        body: JSON.stringify({
          channel,
          args: args.map((value) =>
            value === undefined ? { kind: "absent" } : { kind: "value", value }
          ),
        }),
      })
      if (!reply.ok) throw new Error("The Mako host is unavailable")
      // This transport shares createMakoBridge's result contract with Electron IPC.
      const result = await reply.json()
      if (!result.ok) throw new Error(result.error)
      if (channel === "mako:boot" && import.meta.env.MAKO_SOURCE_ROOT) return { ...result.value, sourceRoot: import.meta.env.MAKO_SOURCE_ROOT }
      return result.value
    },
    onEvent: (listener) => {
      events.add(listener)
      return () => {
        events.delete(listener)
      }
    },
    onTerminalEvent: (listener) => {
      terminals.add(listener)
      return () => {
        terminals.delete(listener)
      }
    },
    pathForFile: () => null,
    resolveFileUrl: (url) => {
      if (!url.startsWith("mako-file:")) return url
      const target = new URL(url)
      target.searchParams.set("client", clientId)
      return target.href.replace(/^mako-file:\/\/(asset|workspace)\//, "/__mako/file/$1/")
    },
  })
  window.addEventListener("pagehide", () => { stopped = true; void reader.cancel().catch(() => {}) }, { once: true })
  void (async () => {
    while (!stopped) {
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          consume(chunk.value)
        }
      } catch {
        connected = false
      } finally {
        connected = false
        reader.releaseLock()
      }
      if (stopped) return
      for (const listener of events) listener({ type: "host-disconnected", message: "Reconnecting to the shared Mako host. Unconfirmed messages will not be resent automatically." })
      for (let attempt = 0; !stopped; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 500 * (attempt + 1))))
        try {
          const next = await fetch("/__mako/events", { method: "POST", headers: { "x-mako-client": "web", "x-mako-window": clientId } })
          if (!next.ok || !next.body) continue
          reader = next.body.pipeThrough(new TextDecoderStream()).getReader()
          pending = ""
          break
        } catch { connected = false }
      }
    }
  })()
}
