import { useCallback, useEffect, useSyncExternalStore } from "react"
import { getMako, hasBridge } from "@/lib/bridge"
import type { WorkspaceFile } from "@/lib/types"
import { useSession } from "@/state/session"

/**
 * The workspace file index, loaded lazily.
 *
 * Nothing needs this until the moment someone types `@`, and a large repo's
 * file list is the kind of payload that has no business being in the boot
 * path. It is fetched on first use and refreshed when the workspace moves.
 */

let files: WorkspaceFile[] = []
let loadedFor: string | null = null
let loadGeneration = 0
let inFlightFor: string | null = null
const listeners = new Set<() => void>()

function publish() {
  for (const listener of listeners) listener()
}

function load(cwd: string) {
  if (inFlightFor === cwd || loadedFor === cwd || !hasBridge()) return
  const mine = ++loadGeneration
  inFlightFor = cwd
  void getMako()
    .listFiles()
    .then((next) => {
      if (mine !== loadGeneration) return
      files = next
      loadedFor = cwd
      publish()
    })
    .catch(() => {
      if (mine !== loadGeneration) return
      files = []
      publish()
    })
    .finally(() => {
      if (mine === loadGeneration) inFlightFor = null
    })
}

export function invalidateWorkspaceFiles() {
  loadGeneration += 1
  inFlightFor = null
  loadedFor = null
  files = []
  publish()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const EMPTY_FILES: WorkspaceFile[] = []

/** `active` gates the fetch, so merely rendering the composer costs nothing. */
export function useWorkspaceFiles(
  active: boolean,
  focusedCwd?: string
): WorkspaceFile[] {
  const sessionCwd = useSession((state) => state.meta?.cwd)
  const cwd = focusedCwd ?? sessionCwd

  useEffect(() => {
    if (active && cwd) load(cwd)
  }, [active, cwd])

  const snapshot = useCallback(
    () => (cwd && loadedFor === cwd ? files : EMPTY_FILES),
    [cwd]
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
