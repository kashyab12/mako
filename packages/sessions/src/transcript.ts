/**
 * The universal transcript builder.
 *
 * One conversation, from any harness, rendered so another model can pick it
 * up and *actually know it* — which is a formatting problem before it is
 * anything else. Three decisions carry the weight:
 *
 *   * **Newest first.** A model reading a long document front-to-back spends
 *     its attention on the oldest turns and skims the end — precisely
 *     backwards for continuation, where the latest state is the work. So the
 *     transcript leads with the most recent turn and counts backwards, and
 *     says so at the top.
 *   * **Everything, not a summary.** Tool calls with their inputs and
 *     outputs, what the user said verbatim, what the agent concluded. A
 *     summary of a session is someone else's opinion of what mattered;
 *     the next agent deserves the record. When the whole record cannot fit,
 *     the oldest turns compress to their text before anything recent loses
 *     a byte — and the cut is declared, never silent.
 *   * **One format regardless of source.** A Codex rollout and a Cursor
 *     SQLite store read identically here. The reader should not be able to
 *     tell where the conversation came from except by being told.
 */

import type { Thread, ThreadEntry } from "./format.js"

/** Characters the full transcript may spend. ~100k tokens of context. */
const DEFAULT_BUDGET = 400_000

/** Tool output inside a fully-rendered turn is clipped to this. */
const TOOL_OUTPUT_MAX = 2_000
const TOOL_INPUT_MAX = 600

export interface TranscriptOptions {
  /** Display name of the harness the thread came from, for the preamble. */
  from?: string
  /** What the user wants next, placed at the very top when given. */
  instruction?: string
  budget?: number
}

interface Turn {
  user: ThreadEntry & { kind: "user" }
  rest: ThreadEntry[]
}

/**
 * Render the whole conversation for continuation elsewhere, newest first.
 */
export function renderTranscript(thread: Thread, options: TranscriptOptions = {}): string {
  const budget = options.budget ?? DEFAULT_BUDGET
  const turns = groupTurns(thread.entries)
  const total = turns.length

  // Newest first, spending the budget from the newest backwards: recent
  // turns arrive whole, older ones fall back to their prose, and only when
  // even that cannot fit does a turn drop — counted, not hidden.
  const rendered: string[] = []
  let spent = 0
  let compressed = 0
  let dropped = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (!turn) continue
    const number = index + 1
    const full = renderTurn(turn, number, total, true)
    if (spent + full.length <= budget) {
      rendered.push(full)
      spent += full.length
      continue
    }
    const brief = renderTurn(turn, number, total, false)
    if (spent + brief.length <= budget) {
      rendered.push(brief)
      spent += brief.length
      compressed += 1
      continue
    }
    dropped = number
    break
  }

  const source = options.from ?? thread.ref.harness
  const where = thread.ref.cwd ? ` in \`${thread.ref.cwd}\`` : ""
  const header = [
    `# Continuing a conversation`,
    ``,
    `This conversation began with another coding agent (${source})${where} and you are taking it over. ` +
      `The full transcript follows in **reverse order — the most recent turn first**, because the most ` +
      `recent turns are the current state of the work. Read it **in its entirety** before doing anything: ` +
      `the early turns (at the bottom) explain what was asked for, and the late turns (at the top) are ` +
      `where things stand now. Do not act on a partial reading. Where the transcript abridges a tool ` +
      `output, the repository itself is the ground truth.`,
    ``,
    `${total} turn${total === 1 ? "" : "s"} total, numbered oldest to newest — so Turn ${total} (first below) is the latest.`,
  ]
  if (dropped > 0) {
    header.push(
      ``,
      `Turns 1–${dropped} were too old to include; everything after them is here${compressed > 0 ? `, the oldest of it compressed to its prose` : ""}.`
    )
  } else if (compressed > 0) {
    header.push(``, `The oldest ${compressed} turn${compressed === 1 ? "" : "s"} are compressed to their prose; every other turn is complete.`)
  }
  const instruction = options.instruction
    ? [`## What to do next`, ``, options.instruction, ``, `---`, ``]
    : []

  return [...header, ``, ...instruction, `---`, ``, rendered.join("\n\n---\n\n")].join("\n")
}

/** Group the flat entry list into user-initiated turns. */
function groupTurns(entries: ThreadEntry[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  for (const entry of entries) {
    if (entry.kind === "user") {
      current = { user: entry, rest: [] }
      turns.push(current)
    } else if (current) {
      current.rest.push(entry)
    }
    // Assistant entries before any user turn are harness preamble; dropped.
  }
  return turns
}

function renderTurn(turn: Turn, number: number, total: number, full: boolean): string {
  const parts: string[] = []
  const marker = number === total ? ` — the latest turn` : ""
  parts.push(`## Turn ${number} of ${total}${marker}`)
  parts.push(``)
  parts.push(`**User:**`)
  parts.push(turn.user.text.trim())

  const agent: string[] = []
  for (const entry of turn.rest) {
    if (entry.kind === "event") {
      agent.push(`*[${entry.label}${entry.detail ? `: ${entry.detail}` : ""}]*`)
      continue
    }
    if (entry.kind !== "assistant") continue
    for (const block of entry.blocks) {
      if (block.type === "text" && block.text.trim()) {
        agent.push(block.text.trim())
      }
      if (block.type === "tool") {
        if (full) {
          const input = block.input ? clip(oneLine(block.input), TOOL_INPUT_MAX) : ""
          const lines = [`\`${block.name}\`${block.error ? " **(failed)**" : ""}${input ? ` — ${input}` : ""}`]
          if (block.output?.trim()) {
            lines.push("```", clip(block.output.trim(), TOOL_OUTPUT_MAX), "```")
          }
          agent.push(lines.join("\n"))
        } else {
          agent.push(`\`${block.name}\`${block.error ? " (failed)" : ""}`)
        }
      }
      // Thinking stays private to the original agent.
    }
  }
  if (agent.length > 0) {
    parts.push(``)
    parts.push(`**Assistant:**`)
    parts.push(agent.join("\n\n"))
  }
  return parts.join("\n")
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
