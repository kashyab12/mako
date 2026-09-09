import {
  createMakoBridge,
  type HostEvent,
  type TerminalEvent,
} from "../../electron/shared.ts"

type WebEvent =
  | { channel: "ready" }
  | { channel: "event"; payload: HostEvent }
  | { channel: "terminal"; payload: TerminalEvent }

/** Vite forwards only same-origin requests to the actual host's private socket. */
export async function installWebBridge(): Promise<void> {
  const events = new Set<(event: HostEvent) => void>()
  const terminals = new Set<(event: TerminalEvent) => void>()
  let connected = false
  const clientId = crypto.randomUUID()
  const response = await fetch("/__mako/events", {
    method: "POST",
    headers: { "x-mako-client": "web", "x-mako-window": clientId },
  })
  if (!response.ok || !response.body)
    throw new Error(
      "The real Mako host is unavailable. Start it with npm run web."
    )
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ""
  const dispatch = (line: string) => {
    if (!line.trim()) return
    // Same typed producer as Electron IPC; only the authenticated local host writes this stream.
    const event: WebEvent = JSON.parse(line)
    if (event.channel === "ready") connected = true
    else if (event.channel === "event") {
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
      if (!connected)
        throw new Error(
          "The Mako host disconnected. Restart npm run web and reload this page."
        )
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
    resolveFileUrl: (url) =>
      url.replace(/^mako-file:\/\/(asset|workspace)\//, "/__mako/file/$1/"),
  })
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        consume(chunk.value)
      }
    } finally {
      connected = false
      reader.releaseLock()
      for (const listener of events)
        listener({
          type: "host-disconnected",
          message:
            "The Mako host disconnected. Restart the host, then reconnect.",
        })
    }
  })().catch(() => {})
}
