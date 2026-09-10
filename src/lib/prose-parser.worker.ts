import { z } from "zod"
import { parseProse, type ProseParseReply } from "./parsed-markdown"

const input = z.object({ text: z.string() })
globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const port = event.ports[0]
  if (!port) return
  let reply: ProseParseReply
  try {
    reply = { ok: true, tree: parseProse(input.parse(event.data).text) }
  } catch {
    reply = { ok: false }
  }
  port.postMessage(reply)
  port.close()
})
