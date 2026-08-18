/**
 * Continue a conversation on a different harness.
 *
 * There is no honest way to transplant one agent's private state — encrypted
 * reasoning, KV caches, provider message ids — into another agent. What *can*
 * move is the conversation itself: what was asked, what was done, what was
 * decided. A handoff renders exactly that, as a first message for the new
 * harness, and says plainly what it is.
 *
 * The budget spends itself from the end backwards: recent turns arrive whole,
 * older ones as their text with tools collapsed to one line, and everything
 * before the budget as a single count. Recency is the right bias — the next
 * turn depends on the last few far more than on the first few — and the
 * receiving agent can always be pointed at the repository for ground truth.
 */

import type { Thread, ThreadEntry } from "./format.js"

/** Characters of transcript a handoff may carry. ~24k tokens of context. */
const DEFAULT_BUDGET = 96_000

/** Tool output inside a fully-rendered turn is clipped to this. */
const TOOL_OUTPUT_MAX = 1_500

export interface HandoffOptions {
  /** Display name of the harness the thread came from, for the preamble. */
  from?: string
  /** What the user wants next, appended after the transcript when given. */
  instruction?: string
  budget?: number
}

/** Render a thread as the opening message of a new session elsewhere. */
export function renderHandoff(thread: Thread, options: HandoffOptions = {}): string {
  const budget = options.budget ?? DEFAULT_BUDGET
  const rendered: string[] = []
  let spent = 0
  let dropped = 0

  for (let index = thread.entries.length - 1; index >= 0; index -= 1) {
    const entry = thread.entries[index]
    if (!entry) continue
    const text = renderEntry(entry, spent < budget / 2)
    if (!text) continue
    if (spent + text.length > budget) {
      dropped = countTurns(thread.entries.slice(0, index + 1))
      break
    }
    rendered.push(text)
    spent += text.length
  }
  rendered.reverse()

  const source = options.from ?? thread.ref.harness
  const where = thread.ref.cwd ? ` in \`${thread.ref.cwd}\`` : ""
  const head =
    `You are continuing a conversation that began with another coding agent (${source})${where}. ` +
    `The transcript so far is below. Continue the work; treat the repository itself as the source ` +
    `of truth where the transcript is abridged.`
  const omitted =
    dropped > 0 ? `\n\n[${dropped} earlier turn${dropped === 1 ? "" : "s"} omitted for length]` : ""
  const tail = options.instruction ? `\n\n---\n\n${options.instruction}` : ""

  return `${head}${omitted}\n\n---\n\n${rendered.join("\n\n")}${tail}`
}

function renderEntry(entry: ThreadEntry, full: boolean): string {
  switch (entry.kind) {
    case "user":
      return `**User:**\n${entry.text}`
    case "event":
      return entry.detail ? `*[${entry.label}: ${entry.detail}]*` : `*[${entry.label}]*`
    case "assistant": {
      const parts: string[] = []
      for (const block of entry.blocks) {
        if (block.type === "text" && block.text.trim()) parts.push(block.text)
        if (block.type === "tool") {
          if (full) {
            const input = block.input ? ` ${clipTo(block.input, 400)}` : ""
            const output = block.output ? `\n> ${clipTo(block.output, TOOL_OUTPUT_MAX).replace(/\n/g, "\n> ")}` : ""
            parts.push(`\`${block.name}\`${input}${output}`)
          } else {
            parts.push(`\`${block.name}\`${block.error ? " (failed)" : ""}`)
          }
        }
        // Thinking stays private to the original agent — it was never shown
        // to the user either, and other harnesses should not inherit it.
      }
      return parts.length > 0 ? `**Assistant:**\n${parts.join("\n\n")}` : ""
    }
  }
}

function clipTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function countTurns(entries: ThreadEntry[]): number {
  return entries.filter((entry) => entry.kind === "user").length
}
