import type { PiMessage } from "@/lib/types"
import { textOf } from "@/lib/format"

/**
 * An exchange is one question and everything the agent did to answer it.
 *
 * The transcript is grouped this way because that is the unit people actually
 * think in. It also settles two things that were wrong when every message was
 * its own row: "copy" belongs to the whole answer rather than appearing on
 * each fragment of it, and the turn navigator has something meaningful to jump
 * between.
 */
export interface Exchange {
  /** Stable across re-renders: the id of the message that opened the exchange. */
  id: string
  /** The user's message, absent for anything the agent said unprompted. */
  prompt?: PiMessage
  /** Assistant and tool messages answering it, in order. */
  response: PiMessage[]
  /** Notes and separators that landed inside this exchange. */
  system: PiMessage[]
  timestamp?: number
}

export function toExchanges(messages: PiMessage[]): Exchange[] {
  const exchanges: Exchange[] = []
  let current: Exchange | null = null

  for (const message of messages) {
    if (message.role === "user") {
      current = {
        id: message.id,
        prompt: message,
        response: [],
        system: [],
        timestamp: message.timestamp,
      }
      exchanges.push(current)
      continue
    }

    if (!current) {
      // The agent spoke first — a resumed session, or a system note before any
      // prompt. It still needs somewhere to live.
      current = { id: `lead-${message.id}`, response: [], system: [], timestamp: message.timestamp }
      exchanges.push(current)
    }

    if (message.role === "system") current.system.push(message)
    else current.response.push(message)
  }

  return exchanges
}

/** Everything the agent said in an exchange, as plain text for the clipboard. */
export function responseText(exchange: Exchange): string {
  return exchange.response
    .filter((message) => message.role === "assistant")
    .map((message) => textOf(message.blocks))
    .filter(Boolean)
    .join("\n\n")
}

/** A one-line label for the navigator and the jump list. */
export function promptLabel(exchange: Exchange): string {
  const text = exchange.prompt ? textOf(exchange.prompt.blocks) : ""
  const line = text.replace(/\s+/g, " ").trim()
  if (line) return line
  return exchange.response.length > 0 ? "Agent turn" : "Empty turn"
}
