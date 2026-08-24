/**
 * The canonical shape of a coding-agent conversation.
 *
 * Every provider keeps its own session store in its own format. This module
 * is the one shape they all
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
export type Harness = "codex" | "claude" | "cursor" | "grok" | "devin" | (string & {})

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
  workspace?: string
  title?: string
  model?: string
  startedAt?: string
  updatedAt?: string
  /** Bytes of the native store — a cheap staleness check and a size hint. */
  bytes?: number
  /** The provider reports that another live client holds this native session. */
  locked?: boolean
  active?: boolean
  /** Earlier harnesses this conversation lived on, oldest first. */
  lineage?: ThreadOrigin[]
  /** The provider behind the model, when the harness records one. */
  modelProvider?: string
  /**
   * True when this ref is served from Mako's own archive because the native
   * store no longer has it. Read-only history: still readable, still
   * movable to any harness — no longer resumable by its original CLI.
   */
  archived?: boolean
}

/** A full conversation: the identity plus every entry, in order. */
export interface Thread {
  ref: ThreadRef
  entries: ThreadEntry[]
}

export interface ThreadPage {
  ref: ThreadRef
  entries: ThreadEntry[]
  start: number
  total: number
  hasEarlier: boolean
}

/** First line of the first user turn — the default title for every harness. */
export function titleFrom(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text.trimStart().split("\n", 1)[0]?.trim()
  if (!line) return undefined
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** Clip tool payloads: catalogues and handoffs need shape, not megabytes. */
export function clip(text: string | undefined, max = 256_000): string | undefined {
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
  private maxCharacters: number
  private droppedEntries = 0
  private droppedUsers = 0
  entries: ThreadEntry[] = []

  constructor(max = 6000, maxCharacters = 32 * 1024 * 1024) {
    this.max = max
    this.maxCharacters = maxCharacters
  }

  push(entry: ThreadEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.max) this.drop(Math.ceil(this.max / 4))
  }

  snapshot(): ThreadEntry[] {
    let characters = this.entries.reduce((sum, entry) => sum + entryCharacters(entry), 0)
    while (this.entries.length > 1 && characters > this.maxCharacters) {
      const count = Math.max(1, Math.ceil(this.entries.length / 8))
      const removed = this.entries.slice(0, count)
      characters -= removed.reduce((sum, entry) => sum + entryCharacters(entry), 0)
      this.drop(count)
    }
    return this.droppedEntries > 0
      ? [
          {
            kind: "event",
            label: "Earlier history not shown",
            detail: `${this.droppedEntries} earlier entries (${this.droppedUsers} user turns) remain in the native session file`,
          },
          ...this.entries,
        ]
      : this.entries
  }

  done(): ThreadEntry[] {
    return this.snapshot()
  }

  private drop(count: number): void {
    const cut = this.entries.splice(0, count)
    this.droppedEntries += cut.length
    this.droppedUsers += cut.filter((entry) => entry.kind === "user").length
  }
}

function entryCharacters(entry: ThreadEntry): number {
  if (entry.kind === "user") return entry.text.length
  if (entry.kind === "event") return entry.label.length + (entry.detail?.length ?? 0)
  return entry.blocks.reduce((sum, block) => {
    if (block.type === "text" || block.type === "thinking") return sum + block.text.length
    return sum + block.name.length + (block.input?.length ?? 0) + (block.output?.length ?? 0)
  }, 0)
}
