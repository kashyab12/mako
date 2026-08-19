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

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { app } from "electron"
import {
  connectDaemon,
  PROTOCOL_VERSION,
  defaultCatalog,
  DevinRemote,
  emitClaudeSession,
  emitCodexSession,
  emitCursorSession,
  emitGrokSession,
  emitPiSession,
  renderTranscript,
  type DaemonClient,
  type DaemonStats,
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
let daemon: DaemonClient | null = null
/** Daemon mode's synchronous view: filled once, patched by events. */
const mirror = new Map<string, ThreadRef>()
let devinSender: DevinRemote | null = null
let emit: (event: HostEvent) => void = () => {}
let pushTimer: NodeJS.Timeout | null = null

/**
 * Prefer the daemon; run locally only when it cannot exist.
 *
 * The daemon owns the watchers and the always-warm cache, so the app's
 * "scan" becomes one socket round-trip — and sync keeps happening while no
 * window is open, which is the entire point of having one. The app spawns
 * it if it is not running (as this process's own runtime in Node mode — no
 * second Node ships for forty lines) and exactly one survives, because the
 * daemon exits quietly when another already answers.
 */
export function installThreads(send: (event: HostEvent) => void): void {
  emit = send
  void (async () => {
    try {
      await loadLineage()
      devinSender = new DevinRemote(await devinAccounts())
      if (await connectViaDaemon()) return
      spawnDaemon()
      await new Promise((resolve) => setTimeout(resolve, 2500))
      if (await connectViaDaemon()) return
      await runLocalCatalog()
    } catch (error) {
      // A catalog that failed to build must say so — an empty rail with no
      // explanation reads as "the feature is broken", which it would be.
      emit({
        type: "notice",
        level: "error",
        message: `The thread catalog failed to start: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  })()
}

async function connectViaDaemon(): Promise<boolean> {
  try {
    const client = await connectDaemon()
    if (client.stats.version < PROTOCOL_VERSION) {
      // An older daemon serves refs shaped for its own vintage. Retire it
      // and report no daemon — the caller spawns a fresh one.
      await client.retire().catch(() => {})
      client.close()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return false
    }
    daemon = client
    mirror.clear()
    for (const ref of await client.list()) mirror.set(ref.path, ref)
    push()
    client.onEvent((event) => {
      if (event.event === "added" || event.event === "updated") {
        mirror.set(event.ref.path, event.ref)
        if (event.event === "added") bindLineage(event.ref)
        schedulePush()
      } else if (event.event === "removed") {
        mirror.delete(event.path)
        schedulePush()
      } else if (event.event === "entries") {
        emit({ type: "thread-entries", path: event.path, entries: event.entries, replace: event.replace })
      }
    })
    client.onClose(() => {
      // The daemon died underneath us; carry on locally rather than blank.
      daemon = null
      void runLocalCatalog().catch(() => {})
    })
    return true
  } catch {
    return false
  }
}

function spawnDaemon(): void {
  const script = join(
    app.getAppPath(),
    "node_modules",
    "@mako",
    "sessions",
    "dist",
    "daemon-main.js"
  )
  if (!existsSync(script)) return
  try {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch {
    // The local catalog covers it.
  }
}

async function runLocalCatalog(): Promise<void> {
  if (catalog) return
  catalog = defaultCatalog({
    cachePath: join(app.getPath("userData"), "threads-catalog.json"),
    // Same archive the daemon uses — whichever process runs the catalog,
    // the durable copy lands in one place.
    archivePath: join(homedir(), ".mako", "archive"),
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
}

/** Whether a source is serving — the renderer's retry asks this. */
export function threadsReady(): boolean {
  return daemon !== null || catalog !== null
}

/** For the settings surface: is the daemon doing the work, and since when. */
export function daemonStatus(): DaemonStats | null {
  return daemon?.stats ?? null
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
  // Sending needs only the account key, not the catalog, so it works the
  // same whichever process owns the watchers.
  if (!devinSender?.configured || !devinSender.owns(path)) return false
  await devinSender.send(path, message)
  return true
}

/** Harnesses whose sessions are remote and replyable through their API. */
export function remoteHarnesses(): string[] {
  return devinSender?.configured ? ["devin"] : []
}

/** A new Devin cloud session from a prompt; polling surfaces it shortly. */
export async function startDevin(prompt: string): Promise<{ sessionId: string; path: string }> {
  if (!devinSender?.configured) {
    throw new Error("Add a Devin service key in Settings → Agents first")
  }
  return devinSender.createSession(prompt)
}

export function stopThreads(): void {
  catalog?.stop()
  catalog = null
  daemon?.close()
  daemon = null
  mirror.clear()
  if (pushTimer) clearTimeout(pushTimer)
}

export function listThreads(filter: { cwd?: string; harness?: string } = {}): ThreadRef[] {
  const refs = daemon
    ? [...mirror.values()]
        .filter(
          (ref) =>
            (!filter.cwd || ref.cwd === filter.cwd) &&
            (!filter.harness || ref.harness === filter.harness)
        )
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    : (catalog?.list(filter) ?? [])
  return refs.slice(0, LIST_CAP).map(annotate)
}

export async function openThread(path: string): Promise<Thread | null> {
  const thread = daemon ? await daemon.open(path) : await (catalog?.open(path) ?? null)
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
  if (daemon) {
    const client = daemon
    void client.follow(path, fromByte).catch(() => {})
    unfollow = () => void client.unfollow(path).catch(() => {})
    return
  }
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

/** Materialize a thread as a native Codex rollout, resumable by id. */
export async function emitThreadAsCodex(
  path: string
): Promise<{ thread: Thread; sessionId: string; sessionPath: string } | null> {
  const thread = await openThread(path)
  if (!thread) return null
  const emitted = await emitCodexSession(thread)
  return { thread, sessionId: emitted.sessionId, sessionPath: emitted.path }
}

/** Every harness whose store we can write, behind one door. */
export async function emitThreadAs(
  path: string,
  harness: string
): Promise<{ thread: Thread; sessionId: string; sessionPath: string } | null> {
  const thread = await openThread(path)
  if (!thread) return null
  const emitter =
    harness === "claude"
      ? emitClaudeSession
      : harness === "codex"
        ? emitCodexSession
        : harness === "grok"
          ? emitGrokSession
          : harness === "cursor"
            ? emitCursorSession
            : harness === "pi"
              ? emitPiSession
              : null
  if (!emitter) return null
  const emitted = await emitter(thread, {})
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
