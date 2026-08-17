/**
 * Hot-update feedback.
 *
 * When a session is pointed at Mako's own source, the agent's edits are applied
 * into this running window by Vite — no reload, no lost session, no lost scroll
 * position. That is the whole point of editing it from inside itself, and it is
 * also completely invisible: a component swaps and, if the change was subtle,
 * nothing appears to have happened at all.
 *
 * So the swap gets announced. Not because the user needs to act on it, but
 * because "did that apply?" is otherwise unanswerable without a manual check,
 * and an agent that edits code you cannot confirm is worse than no agent.
 *
 * Development only. `import.meta.hot` is undefined in a build, so this whole
 * module tree-shakes out.
 */

export interface HotUpdate {
  /** Renderer paths that were swapped in, workspace-relative. */
  files: string[]
  /** Monotonic, so a repeated edit to one file still reads as a new event. */
  at: number
}

type Listener = (update: HotUpdate) => void

const listeners = new Set<Listener>()

export function onHotUpdate(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce(files: string[]) {
  if (files.length === 0) return
  const update = { files, at: Date.now() }
  for (const listener of listeners) listener(update)
}

if (import.meta.hot) {
  import.meta.hot.on("vite:afterUpdate", (payload) => {
    announce(
      payload.updates
        // `acceptedPath` is the module that actually took the update;
        // `path` can be an importer several hops up, which is not what
        // anyone edited.
        .map((update) => update.acceptedPath.replace(/^\/(@fs\/)?/, "").split("?")[0])
        // Vite re-fetches the stylesheet as one opaque module on any CSS
        // change; naming it would be noise, but the fact of it is not.
        .map((path) => (path.endsWith(".css") ? "index.css" : path))
    )
  })

  // A full reload means Fast Refresh gave up — usually because a module
  // exported something other than components alongside them. Worth saying,
  // because it is the one case where the session does *not* survive.
  import.meta.hot.on("vite:beforeFullReload", () => {
    sessionStorage.setItem("mako:full-reload", "1")
  })
}

/** True exactly once, on the first read after a full reload. */
export function consumeFullReload(): boolean {
  if (!import.meta.hot) return false
  const flagged = sessionStorage.getItem("mako:full-reload") === "1"
  if (flagged) sessionStorage.removeItem("mako:full-reload")
  return flagged
}
