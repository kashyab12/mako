import { join } from "node:path"
import { parseSessionEntries } from "@earendil-works/pi-coding-agent"
import type { WorkspaceGit } from "./host-git.js"
import { readText, walkWorkspace } from "./host-workspace.js"
import { serializeMessage } from "./host-serialization.js"
import type {
  ChatRole,
  FileMatches,
  SearchOptions,
  SearchResults,
  SessionSummary,
  ThreadMatches,
} from "./shared.js"

/* ------------------------------------------------------------------ */
/* search helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Search ceilings.
 *
 * Every one of these exists so a two-character query in a monorepo returns in
 * a moment rather than filling the wire with a result nobody will scroll. What
 * gets cut is always reported — a truncated search that looks complete is the
 * one failure mode worse than a slow one.
 */
const SEARCH_MAX_FILES = 200
const SEARCH_MAX_PER_FILE = 20
const SEARCH_MAX_THREADS = 40
const SEARCH_MAX_PER_THREAD = 8
/** Sessions read before giving up, and the total bytes allowed across them. */
const SEARCH_SCAN_THREADS = 250
const SEARCH_THREAD_BYTES = 64_000_000
/** Files scanned by hand when there is no git index to lean on. */
const SEARCH_WALK_FILES = 5_000

type ListSessions = (
  cwd: string,
  scope: "workspace" | "all"
) => Promise<SessionSummary[]>

/**
 * One predicate for every scan that does not go through `git grep`.
 *
 * Literal queries use `includes` rather than a compiled regex: it is the
 * common case, it is faster, and it means a query full of punctuation does
 * what it looks like it does instead of throwing.
 */
function matcher(term: string, options: SearchOptions): (text: string) => boolean {
  if (options.regex || options.wholeWord) {
    const source = options.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? "" : "i")
    return (text) => pattern.test(text)
  }
  if (options.caseSensitive) return (text) => text.includes(term)
  const lower = term.toLowerCase()
  return (text) => text.toLowerCase().includes(lower)
}

/**
 * Pull the readable part out of one session entry.
 *
 * A session line is a serialized entry, so the raw JSON matched — but showing
 * JSON as a search result is showing the storage rather than the conversation.
 * Only text and reasoning are surfaced; a hit inside a tool's arguments is
 * real but unreadable as a row, and is reported as the message that made it.
 */
function entryText(line: string, test: (text: string) => boolean): { role: ChatRole; text: string } | null {
  // The engine owns the JSONL format and parser. Keep malformed or non-message
  // lines out before projecting the owner contract onto the search result.
  const entry = parseSessionEntries(line)[0]
  if (!entry || entry.type !== "message") return null

  try {
    const message = serializeMessage(entry.message, entry.id)
    const pieces = message.blocks
      .map((block) => block.text ?? block.thinking ?? (block.name ? `→ ${block.name}` : ""))
      .filter(Boolean)

    // Prefer the piece that actually matched, so the row shows the hit rather
    // than whatever happened to come first in a long message.
    const hit = pieces.find((piece) => test(piece)) ?? pieces[0]
    if (!hit) return null
    return { role: message.role, text: snippet(hit, test) }
  } catch {
    // Older extension entries may not honor the current owner contract.
    return null
  }
}

/** A window around the match, so the matched text is visible in one row. */
function snippet(text: string, test: (piece: string) => boolean): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= 200) return flat
  // Binary-search-free: walk in windows until one matches. Cheap at this size.
  for (let start = 0; start < flat.length; start += 100) {
    const window = flat.slice(start, start + 200)
    if (test(window)) return `${start > 0 ? "…" : ""}${window}…`
  }
  return `${flat.slice(0, 200)}…`
}

/**
 * Search the working tree, and optionally past conversations.
 *
 * Two corpora in one answer, because in this app they are one question. "Where
 * did that retry logic go" is answered either by the file that holds it or by
 * the conversation where you decided it — and having to guess which before you
 * search is the kind of small tax that stops people searching at all.
 *
 * Code goes through `git grep`, which is both far faster than anything this
 * process could do and already knows what is ignored. Outside a repo it falls
 * back to a bounded walk, which is slower and says so by being capped.
 */
export async function searchWorkspace(
  cwd: string,
  workspaceGit: WorkspaceGit,
  listSessions: ListSessions,
  query: string,
  options: SearchOptions = {}
): Promise<SearchResults> {
  const started = Date.now()
  const term = query.trim()
  const empty: SearchResults = {
    query: term,
    files: [],
    threads: [],
    total: 0,
    truncated: false,
    elapsed: 0,
  }
  if (term.length < 2) return empty

  if (options.regex) {
    try {
      new RegExp(term)
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : "Invalid pattern" }
    }
  }

  const [files, threads] = await Promise.all([
    searchFiles(cwd, workspaceGit, term, options),
    options.threads === false
      ? Promise.resolve([])
      : searchThreads(cwd, listSessions, term, options),
  ])
  if (workspaceGit.cwd !== cwd) {
    return searchWorkspace(workspaceGit.cwd, workspaceGit, listSessions, query, options)
  }

  const total =
    files.reduce((sum, file) => sum + file.lines.length + file.more, 0) +
    threads.reduce((sum, thread) => sum + thread.lines.length + thread.more, 0)

  return {
    query: term,
    files,
    threads,
    total,
    truncated: files.length >= SEARCH_MAX_FILES || threads.length >= SEARCH_MAX_THREADS,
    elapsed: Date.now() - started,
  }
}

async function searchFiles(
  cwd: string,
  workspaceGit: WorkspaceGit,
  term: string,
  options: SearchOptions
): Promise<FileMatches[]> {
  const raw = await workspaceGit.root()
    ? await workspaceGit.grep(term, options)
    : await walkGrep(cwd, term, options)

  // `path:line:text`, but a path may contain a colon, so split from the left
  // on exactly two separators and leave the rest of the line alone.
  const byPath = new Map<string, FileMatches>()
  for (const entry of raw) {
    const first = entry.indexOf(":")
    const second = entry.indexOf(":", first + 1)
    if (first < 0 || second < 0) continue
    const path = entry.slice(0, first)
    const line = Number(entry.slice(first + 1, second))
    if (!Number.isFinite(line)) continue

    let file = byPath.get(path)
    if (!file) {
      if (byPath.size >= SEARCH_MAX_FILES) continue
      file = { path, lines: [], more: 0 }
      byPath.set(path, file)
    }
    if (file.lines.length >= SEARCH_MAX_PER_FILE) {
      file.more += 1
      continue
    }
    // Long minified lines are useless in a result row and expensive to send.
    file.lines.push({ line, text: entry.slice(second + 1).slice(0, 400) })
  }
  return [...byPath.values()]
}

/** Not a repo: read the bounded file list and scan it here. */
async function walkGrep(cwd: string, term: string, options: SearchOptions): Promise<string[]> {
  const test = matcher(term, options)
  const paths = (await walkWorkspace(cwd, cwd, 0)).slice(0, SEARCH_WALK_FILES)
  const out: string[] = []
  for (const path of paths) {
    if (out.length >= SEARCH_MAX_FILES * SEARCH_MAX_PER_FILE) break
    const text = await readText(join(cwd, path))
    if (text === null || text.includes("\0")) continue
    const lines = text.split("\n")
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ""
      if (test(line)) out.push(`${path}:${index + 1}:${line}`)
    }
  }
  return out
}

/**
 * Search past conversations.
 *
 * Sessions are JSONL, so the cheap thing is right: test the raw line first
 * and only parse the ones that hit. A miss costs a substring search, not a
 * JSON parse, which is what makes scanning a few hundred sessions viable.
 */
async function searchThreads(
  cwd: string,
  listSessions: ListSessions,
  term: string,
  options: SearchOptions
): Promise<ThreadMatches[]> {
  const test = matcher(term, options)
  const sessions = await listSessions(cwd, options.scope ?? "workspace").catch(() => [])
  const results: ThreadMatches[] = []
  let budget = SEARCH_THREAD_BYTES

  for (const session of sessions.slice(0, SEARCH_SCAN_THREADS)) {
    if (results.length >= SEARCH_MAX_THREADS || budget <= 0) break
    const text = await readText(session.path)
    if (text === null) continue
    budget -= text.length
    if (!test(text)) continue

    const match: ThreadMatches = {
      path: session.path,
      title: session.name || session.firstMessage.slice(0, 80) || "Untitled session",
      cwd: session.cwd,
      modified: session.modified,
      lines: [],
      more: 0,
    }
    for (const line of text.split("\n")) {
      if (!line || !test(line)) continue
      if (match.lines.length >= SEARCH_MAX_PER_THREAD) {
        match.more += 1
        continue
      }
      const found = entryText(line, test)
      if (found) match.lines.push(found)
    }
    if (match.lines.length > 0 || match.more > 0) results.push(match)
  }
  return results
}
