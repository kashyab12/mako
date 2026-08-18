/**
 * The machine's sessions, whoever wrote them.
 *
 * This is the main-process face of `@mako/sessions`: one catalog over every
 * harness's native store — Pi, Codex, Claude Code, Cursor, Grok — scanned
 * once, watched continuously, and pushed to the renderer whenever anything
 * anywhere writes a session. Open a Codex conversation in a terminal and it
 * appears in the rail mid-turn; that is not an import feature, it is a file
 * watcher, which is why it works for apps that have never heard of this one.
 *
 * Continuation is the other half. A Pi session opens natively. Any other
 * harness's session is rendered through the handoff — the conversation as a
 * first message, said plainly — into a fresh tab in the same working
 * directory. No harness can inherit another's private state; it can inherit
 * the conversation, and that is what this hands over.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { app } from "electron"
import {
  defaultCatalog,
  emitClaudeSession,
  emitPiSession,
  renderTranscript,
  type DevinAccount,
  type SessionCatalog,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
} from "@mako/sessions"
import { annotate, bindLineage, loadLineage } from "./lineage.js"
import type { HostEvent } from "./shared.js"

/** Refs sent to the renderer per push. Nobody scrolls ten years of history. */
const LIST_CAP = 600

/** Catalog changes are bursty (an agent mid-turn saves constantly). */
const PUSH_DEBOUNCE_MS = 300

let catalog: SessionCatalog | null = null
let emit: (event: HostEvent) => void = () => {}
let pushTimer: NodeJS.Timeout | null = null

export function installThreads(send: (event: HostEvent) => void): void {
  emit = send
  void (async () => {
    await loadLineage()
    catalog = defaultCatalog({
      cachePath: join(app.getPath("userData"), "threads-catalog.json"),
      devinAccounts: await devinAccounts(),
    })
    await catalog.scan()
    push()
    catalog.startWatching()
    catalog.onEvent((event) => {
      // A new session may be the one a continuation is waiting to claim.
      if (event.type === "added") bindLineage(event.ref)
      schedulePush()
    })
  })()
}

/**
 * Devin accounts, from `~/.mako/devin.json`:
 *
 *     { "accounts": [{ "name": "work", "apiKey": "apk_…" }] }
 *
 * A service key from app.devin.ai settings — the CLI's own credentials
 * authenticate a different surface and cannot list sessions. No file, no
 * Devin: the source simply is not registered.
 */
async function devinAccounts(): Promise<DevinAccount[]> {
  try {
    const raw = await readFile(join(homedir(), ".mako", "devin.json"), "utf8")
    const parsed = JSON.parse(raw) as { accounts?: DevinAccount[] }
    return Array.isArray(parsed.accounts) ? parsed.accounts : []
  } catch {
    return []
  }
}

/** The configured Devin accounts, keys masked for display. */
export async function devinAccountsMasked(): Promise<Array<{ name: string; key: string }>> {
  const accounts = await devinAccounts()
  return accounts.map((account) => ({
    name: account.name,
    key: `apk_…${account.apiKey.slice(-4)}`,
  }))
}

/**
 * Replace the Devin accounts and rebuild the catalog around them. The scan
 * after a rebuild is warm — unchanged files are stat-only — so this costs a
 * moment, not a rescan of the world.
 */
export async function saveDevinAccounts(accounts: DevinAccount[]): Promise<void> {
  // The renderer never sees real keys, so an unchanged account arrives as
  // the sentinel "__keep__" and keeps the key already on disk.
  const existing = await devinAccounts()
  const resolved = accounts.flatMap((account) => {
    if (account.apiKey !== "__keep__") return [account]
    const kept = existing.find((entry) => entry.name === account.name)
    return kept ? [kept] : []
  })
  const { mkdir, writeFile } = await import("node:fs/promises")
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "devin.json"), JSON.stringify({ accounts: resolved }, null, 2) + "\n", "utf8")
  const send = emit
  stopThreads()
  installThreads(send)
}

/** Whether a path belongs to a remote source (and can be replied to by it). */
export async function sendRemote(path: string, message: string): Promise<boolean> {
  const remote = catalog?.remoteFor(path)
  if (!remote?.send) return false
  await remote.send(path, message)
  return true
}

/** Harnesses whose sessions are remote and replyable through their API. */
export function remoteHarnesses(): string[] {
  return catalog?.remoteHarnesses() ?? []
}

export function stopThreads(): void {
  catalog?.stop()
  catalog = null
  if (pushTimer) clearTimeout(pushTimer)
}

export function listThreads(filter: { cwd?: string; harness?: string } = {}): ThreadRef[] {
  return (catalog?.list(filter).slice(0, LIST_CAP) ?? []).map(annotate)
}

export async function openThread(path: string): Promise<Thread | null> {
  const thread = await (catalog?.open(path) ?? null)
  return thread ? { ...thread, ref: annotate(thread.ref) } : null
}

/**
 * Live entries for the thread open in the viewer.
 *
 * One follow at a time: the viewer shows one conversation, and a second
 * follow request supersedes the first. Entries appended to the native file —
 * by whatever app is writing it — stream to the renderer as they land.
 */
let unfollow: (() => void) | null = null

export function followThread(path: string, fromByte: number): void {
  unfollow?.()
  unfollow =
    catalog?.follow(path, fromByte, (entries: ThreadEntry[], replaced: boolean) => {
      emit({ type: "thread-entries", path, entries, replace: replaced })
    }) ?? null
}

export function unfollowThread(): void {
  unfollow?.()
  unfollow = null
}

const HARNESS_NAMES: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  devin: "Devin",
}

/**
 * The thread rendered for continuation elsewhere: the full universal
 * transcript, newest turn first, with orders to read all of it. Used for
 * harnesses whose native store we cannot yet write; the ones we can write
 * get the real thing via the emitters below.
 */
export async function handoffFor(path: string, instruction?: string): Promise<string | null> {
  const thread = await catalog?.open(path)
  if (!thread) return null
  return renderTranscript(thread, {
    from: HARNESS_NAMES[thread.ref.harness] ?? thread.ref.harness,
    ...(instruction ? { instruction } : {}),
  })
}

/**
 * Materialize a thread as a *native Pi session* — the deepest continuation:
 * the emitted file opens like any Pi session, full history in the
 * transcript and in context, no handoff preamble anywhere.
 */
export async function emitThreadAsPi(path: string): Promise<{ thread: Thread; sessionPath: string } | null> {
  const thread = await openThread(path)
  if (!thread) return null
  const emitted = await emitPiSession(thread)
  return { thread, sessionPath: emitted.path }
}

/** Materialize a thread as a native Claude Code session, resumable by id. */
export async function emitThreadAsClaude(
  path: string
): Promise<{ thread: Thread; sessionId: string; sessionPath: string } | null> {
  const thread = await openThread(path)
  if (!thread) return null
  const emitted = await emitClaudeSession(thread)
  return { thread, sessionId: emitted.sessionId, sessionPath: emitted.path }
}

function schedulePush(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    push()
  }, PUSH_DEBOUNCE_MS)
}

function push(): void {
  emit({ type: "threads", threads: listThreads() })
}
