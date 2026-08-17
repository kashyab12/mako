import { useEffect, useSyncExternalStore } from "react"
import { getPi, hasBridge } from "@/lib/bridge"
import type { WorkspaceFile } from "@/lib/types"
import { store } from "@/state/session"

/**
 * The workspace file index, loaded lazily.
 *
 * Nothing needs this until the moment someone types `@`, and a large repo's
 * file list is the kind of payload that has no business being in the boot
 * path. It is fetched on first use and refreshed when the workspace moves.
 */

let files: WorkspaceFile[] = []
let loadedFor: string | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish() {
  for (const listener of listeners) listener()
}

function load(cwd: string) {
  if (inFlight || loadedFor === cwd || !hasBridge()) return
  inFlight = getPi()
    .listFiles()
    .then((next) => {
      files = next
      loadedFor = cwd
      publish()
    })
    .catch(() => {
      files = []
    })
    .finally(() => {
      inFlight = null
    })
}

export function invalidateWorkspaceFiles() {
  loadedFor = null
  files = []
  publish()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => files

/** `active` gates the fetch, so merely rendering the composer costs nothing. */
export function useWorkspaceFiles(active: boolean): WorkspaceFile[] {
  const cwd = store.get().meta?.cwd

  useEffect(() => {
    if (active && cwd) load(cwd)
  }, [active, cwd])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
