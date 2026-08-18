/**
 * The canonical shape of a coding-agent conversation.
 *
 * Every harness — Codex, Claude Code, Cursor, Grok, Pi, Devin — keeps its own
 * session store in its own format. This module is the one shape they all
 * translate into, and it is deliberately smaller than any of them: it keeps
 * exactly what is needed to *show* a conversation anywhere and to *continue*
 * it anywhere, and it always keeps a pointer back to the native file, which
 * remains the source of truth for anything provider-specific.
 *
 * Lossy on purpose. A canonical format that tries to round-trip every
 * provider's private fields becomes a union of all of them — which is not a
 * format, it is a pile. Fidelity lives in the native store; portability lives
 * here.
 */

/** Which harness a session came from. Open — new harnesses appear monthly. */
export type Harness = "pi" | "codex" | "claude" | "cursor" | "grok" | "devin" | (string & {})

/** Token counts and spend for one assistant turn, when the harness records them. */
export interface TurnUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  costUsd?: number
}

/**
 * One piece of an assistant turn.
 *
 * A tool call and its result are one block, not two entries: for portability
 * and display, "what was run and what came back" is a single fact. Harnesses
 * that stream them separately are merged during translation.
 */
export type EntryBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; input?: string; output?: string; error?: boolean }

/**
 * One entry of a conversation.
 *
 * Three kinds cover every harness surveyed: what the user said, what the
 * agent did, and the occasional out-of-band fact worth showing (a model
 * change, a compaction, a mode switch). Anything a harness records that fits
 * none of these is provider bookkeeping and stays in the native file.
 */
export type ThreadEntry =
  | { kind: "user"; at?: string; text: string }
  | { kind: "assistant"; at?: string; model?: string; usage?: TurnUsage; blocks: EntryBlock[] }
  | { kind: "event"; at?: string; label: string; detail?: string }

/**
 * Where a conversation has been before it got here.
 *
 * A session continued across harnesses keeps its identity: a thread that
 * began on Devin and moved to Claude Code is one conversation wearing two
 * marks, not two unrelated sessions. The chain lists earlier lives oldest
 * first; the ref's own harness is the current one and is not repeated here.
 */
export interface ThreadOrigin {
  harness: Harness
  title?: string
}

/**
 * The cheap identity of a session: everything a list needs, nothing a
 * transcript needs. Built from at most the head and tail of a native file, so
 * cataloguing a thousand sessions stays a moment, not a minute.
 */
export interface ThreadRef {
  harness: Harness
  /** The harness's own id for the session — what its resume flag wants. */
  nativeId: string
  /** The native file (or directory) holding the full session. */
  path: string
  cwd?: string
  title?: string
  model?: string
  startedAt?: string
  updatedAt?: string
  /** Bytes of the native store — a cheap staleness check and a size hint. */
  bytes?: number
  /** Earlier harnesses this conversation lived on, oldest first. */
  lineage?: ThreadOrigin[]
}

/** A full conversation: the identity plus every entry, in order. */
export interface Thread {
  ref: ThreadRef
  entries: ThreadEntry[]
}

/** First line of the first user turn — the default title for every harness. */
export function titleFrom(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.trimStart().split("\n", 1)[0]?.trim()
  if (!line) return undefined
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** Clip tool payloads: catalogues and handoffs need shape, not megabytes. */
export function clip(text: string | undefined, max = 4000): string | undefined {
  if (text === undefined) return undefined
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters]` : text
}

/**
 * Collects translated entries with a ceiling.
 *
 * Session files reach gigabytes; transcripts do not need to. The sink keeps
 * the most recent entries and replaces everything older with one event
 * saying how much was set aside — recency is what continuation and display
 * actually use, and the native file still holds every byte.
 */
export class EntrySink {
  private max: number
  private droppedUsers = 0
  entries: ThreadEntry[] = []

  constructor(max = 6000) {
    this.max = max
  }

  push(entry: ThreadEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.max) {
      const cut = this.entries.splice(0, Math.ceil(this.max / 4))
      this.droppedUsers += cut.filter((dropped) => dropped.kind === "user").length
    }
  }

  done(): ThreadEntry[] {
    if (this.droppedUsers > 0) {
      this.entries.unshift({
        kind: "event",
        label: "Earlier history not shown",
        detail: `${this.droppedUsers} earlier turns remain in the native session file`,
      })
    }
    return this.entries
  }
}
