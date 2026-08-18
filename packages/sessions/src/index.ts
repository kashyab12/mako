/**
 * @mako/sessions — one format for coding-agent sessions.
 *
 * Reads every supported harness's native session store, keeps a live catalog
 * of all of them, and renders any thread for continuation on any other
 * harness. Pure library: node builtins only, no Electron, no UI, so anything
 * — this desktop app, a CLI, a server — can hold the same catalog.
 */

export {
  titleFrom,
  clip,
  type EntryBlock,
  type Harness,
  type Thread,
  type ThreadEntry,
  type ThreadRef,
  type TurnUsage,
} from "./format.js"
export { SessionCatalog, type CatalogEvent, type RemoteSource } from "./catalog.js"
export { renderHandoff, type HandoffOptions } from "./handoff.js"
export { type NativeFile, type SessionProvider } from "./providers/types.js"
export { CodexProvider } from "./providers/codex.js"
export { CursorProvider } from "./providers/cursor.js"
export { GrokProvider } from "./providers/grok.js"
export { ClaudeProvider } from "./providers/claude.js"
export { PiProvider } from "./providers/pi.js"
export { DevinRemote, type DevinAccount } from "./providers/devin.js"

import { SessionCatalog } from "./catalog.js"
import { CodexProvider } from "./providers/codex.js"
import { CursorProvider } from "./providers/cursor.js"
import { GrokProvider } from "./providers/grok.js"
import { ClaudeProvider } from "./providers/claude.js"
import { PiProvider } from "./providers/pi.js"

import { DevinRemote, type DevinAccount } from "./providers/devin.js"

/** The catalog with every built-in provider, ready to scan. */
export function defaultCatalog(
  options: { cachePath?: string; devinAccounts?: DevinAccount[] } = {}
): SessionCatalog {
  const catalog = new SessionCatalog(
    [new PiProvider(), new CodexProvider(), new ClaudeProvider(), new CursorProvider(), new GrokProvider()],
    options
  )
  const devin = new DevinRemote(options.devinAccounts ?? [])
  if (devin.configured) catalog.addRemote(devin)
  return catalog
}
