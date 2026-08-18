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

import { join } from "node:path"
import { app } from "electron"
import {
  defaultCatalog,
  renderHandoff,
  type SessionCatalog,
  type Thread,
  type ThreadRef,
} from "@mako/sessions"
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
  catalog = defaultCatalog({
    cachePath: join(app.getPath("userData"), "threads-catalog.json"),
  })
  void catalog.scan().then(() => {
    push()
    catalog?.startWatching()
    catalog?.onEvent(() => schedulePush())
  })
}

export function stopThreads(): void {
  catalog?.stop()
  catalog = null
  if (pushTimer) clearTimeout(pushTimer)
}

export function listThreads(filter: { cwd?: string; harness?: string } = {}): ThreadRef[] {
  return catalog?.list(filter).slice(0, LIST_CAP) ?? []
}

export async function openThread(path: string): Promise<Thread | null> {
  return catalog?.open(path) ?? null
}

/**
 * The thread rendered for continuation elsewhere, ready to be the first
 * prompt of a new session.
 */
export async function handoffFor(path: string, instruction?: string): Promise<string | null> {
  const thread = await catalog?.open(path)
  if (!thread) return null
  const names: Record<string, string> = {
    pi: "Pi",
    codex: "Codex",
    claude: "Claude Code",
    cursor: "Cursor",
    grok: "Grok",
  }
  return renderHandoff(thread, {
    from: names[thread.ref.harness] ?? thread.ref.harness,
    ...(instruction ? { instruction } : {}),
  })
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
