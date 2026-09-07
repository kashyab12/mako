import { useEffect, useSyncExternalStore } from "react"
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

type FileIndex =
  | { kind: "loading"; files: WorkspaceFile[] }
  | { kind: "ready"; files: WorkspaceFile[] }
  | { kind: "failed"; files: WorkspaceFile[]; error: string }
const EMPTY_INDEX: FileIndex = { kind: "loading", files: [] }
let index: FileIndex = EMPTY_INDEX
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
      index = { kind: "ready", files: next }
      loadedFor = cwd
      publish()
    })
    .catch((error) => {
      if (mine !== loadGeneration) return
      loadedFor = cwd
      index = {
        kind: "failed",
        files: [],
        error:
          error instanceof Error
            ? error.message
            : "Could not read project files",
      }
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
  index = EMPTY_INDEX
  publish()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function retryWorkspaceFiles(cwd: string) {
  invalidateWorkspaceFiles()
  load(cwd)
}

/** `active` gates the fetch, so merely rendering the composer costs nothing. */
export function useWorkspaceFiles(
  active: boolean,
  focusedCwd?: string
): FileIndex {
  const sessionCwd = useSession((state) => state.meta?.cwd)
  const cwd = focusedCwd ?? sessionCwd
  const loadFiles = load

  useEffect(() => {
    if (active && cwd) loadFiles(cwd)
  }, [active, cwd, loadFiles])

  const snapshot = () => (cwd && loadedFor === cwd ? index : EMPTY_INDEX)
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
