/**
 * JSONL plumbing shared by every file-backed provider.
 *
 * The catalog's speed rests on three disciplines here: reads are *bounded*
 * (peeks read a head, never the whole file), reads are *incremental* (a
 * growing session re-reads only the appended bytes), and reads are
 * *streamed* (a full translation walks the file in fixed-size chunks —
 * session files reach gigabytes in the wild, and a gigabyte must never
 * become one JavaScript string).
 */

import { statSync } from "node:fs"
import { open } from "node:fs/promises"
import { EntrySink, type ThreadEntry } from "./format.js"
import type { SessionFollower, SessionUpdate } from "./providers/types.js"

const CHUNK = 4 * 1024 * 1024

export interface LineTranslator {
  push(raw: string): void
  snapshot(): ThreadEntry[]
}

export function snapshotSink(sink: EntrySink): ThreadEntry[] {
  const droppedUsers = (sink as unknown as { droppedUsers: number }).droppedUsers
  return droppedUsers > 0
    ? [
        {
          kind: "event",
          label: "Earlier history not shown",
          detail: `${droppedUsers} earlier turns remain in the native session file`,
        },
        ...sink.entries,
      ]
    : sink.entries
}

interface LineRead {
  nextByte: number
  reset: boolean
  size: number
  identity: string
}

/** Parse one JSONL line, returning null rather than throwing on torn writes. */
export function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The first `bytes` of a file, decoded. */
export async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r")
  try {
    const size = (await handle.stat()).size
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    return buffer.toString("utf8")
  } finally {
    await handle.close()
  }
}

/**
 * Stream complete lines from `fromByte` to the end of the file, in chunks.
 *
 * Returns the offset *after the last newline consumed*, so a line still being
 * written is left for the next call rather than parsed half-formed, and a
 * follow-up costs one positional read of only the new bytes. Splitting is
 * done on the byte, not the decoded string, so a multi-byte character
 * straddling a chunk boundary can never be torn.
 *
 * A callback that returns `false` stops the read — that is how bounded scans
 * (peeks hunting for a title) avoid walking a gigabyte they do not need.
 *
 * If the file shrank below `fromByte` it was rewritten (compaction,
 * truncation); reading restarts from zero so offsets never point into a file
 * that no longer exists in that shape.
 */
async function readLineBatch(
  path: string,
  fromByte: number,
  onLine: (line: string) => void | boolean
): Promise<LineRead> {
  const handle = await open(path, "r")
  try {
    const info = await handle.stat()
    const size = info.size
    const reset = size < fromByte
    let cursor = reset ? 0 : fromByte
    const end = size
    let consumed = cursor
    let carry: Buffer | null = null

    while (cursor < end) {
      const length = Math.min(CHUNK, end - cursor)
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, cursor)
      cursor += length

      const buffer: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      const lastBreak = buffer.lastIndexOf(0x0a)
      if (lastBreak === -1) {
        carry = buffer
        continue
      }
      for (const line of buffer.toString("utf8", 0, lastBreak).split("\n")) {
        if (onLine(line) === false) {
          return { nextByte: consumed, reset, size, identity: `${info.dev}:${info.ino}` }
        }
      }
      consumed += lastBreak + 1
      carry = lastBreak + 1 < buffer.length ? Buffer.from(buffer.subarray(lastBreak + 1)) : null
    }
    return { nextByte: consumed, reset, size, identity: `${info.dev}:${info.ino}` }
  } finally {
    await handle.close()
  }
}

export async function readLines(
  path: string,
  fromByte: number,
  onLine: (line: string) => void | boolean
): Promise<number> {
  return (await readLineBatch(path, fromByte, onLine)).nextByte
}

export function createJsonlFollower(
  path: string,
  fromByte: number,
  createTranslator: () => LineTranslator
): SessionFollower {
  let parser = createTranslator()
  let cursor = fromByte
  let identity: string | null = null
  try {
    const info = statSync(path)
    identity = `${info.dev}:${info.ino}`
  } catch {
    identity = null
  }
  let previousRefs: ThreadEntry[] = []
  let previousValues: string[] = []

  const remember = (entries: ThreadEntry[]) => {
    previousRefs = [...entries]
    previousValues = entries.map((entry) => JSON.stringify(entry))
  }
  const cloneEntries = (entries: ThreadEntry[]): ThreadEntry[] => structuredClone(entries)

  return {
    get offset() {
      return cursor
    },
    async next(): Promise<SessionUpdate> {
      let read = await readLineBatch(path, cursor, parser.push)
      if (read.reset || (identity !== null && read.identity !== identity)) {
        parser = createTranslator()
        read = await readLineBatch(path, 0, parser.push)
        cursor = read.nextByte
        identity = read.identity
        const current = parser.snapshot()
        remember(current)
        return { entries: cloneEntries(current), nextByte: cursor, replace: true, reset: true }
      }

      cursor = Math.max(cursor, read.nextByte)
      identity = read.identity
      const current = parser.snapshot()
      const appended =
        current.length >= previousRefs.length &&
        previousRefs.every(
          (entry, index) => entry === current[index] && previousValues[index] === JSON.stringify(entry)
        )
      const entries = appended ? current.slice(previousRefs.length) : current
      const update: SessionUpdate = {
        entries: cloneEntries(entries),
        nextByte: cursor,
        replace: !appended,
      }
      remember(current)
      return update
    },
  }
}

/** Recursively list files under a root, bounded, without following links. */
export async function walkFiles(
  root: string,
  matches: (name: string) => boolean,
  maxDepth = 5
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  const found: string[] = []
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = `${dir}/${entry.name}`
        if (entry.isDirectory()) return visit(path, depth + 1)
        if (entry.isFile() && matches(entry.name)) found.push(path)
      })
    )
  }
  await visit(root, 0)
  return found
}
