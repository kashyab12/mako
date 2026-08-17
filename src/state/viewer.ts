import { createHook, createStore } from "@/state/store"
import { getPi, hasBridge } from "@/lib/bridge"
import type { FileContents } from "@/lib/types"

/**
 * The file open for reading, if any.
 *
 * Deliberately one file, not a stack of them. Tabs in this app are
 * conversations; a file is something you glance at and dismiss, so it gets the
 * transcript's space for as long as it is open and Escape gives it back. A
 * second tab bar for files would be a second thing to manage for a job that
 * ends the moment you have read the line you came for.
 */

export interface ViewerState {
  /** Workspace-relative path, or undefined when nothing is open. */
  path?: string
  file?: FileContents
  loading: boolean
  error?: string
  /**
   * The line to land on, when the file was opened from a search hit.
   *
   * Carried as state rather than scrolled imperatively because the content
   * arrives after the open: whoever renders it scrolls once it exists.
   */
  line?: number
}

export const viewerStore = createStore<ViewerState>({ loading: false })
export const useViewer = createHook(viewerStore)

/** Bumped per open so a slow read for a file you already closed cannot land. */
let generation = 0

export const viewer = {
  async open(path: string, line?: number) {
    if (!hasBridge()) return
    const mine = ++generation
    viewerStore.set({ path, line, loading: true, error: undefined, file: undefined })
    try {
      const file = await getPi().readFile(path)
      if (mine !== generation) return
      viewerStore.set({ file, loading: false })
    } catch (error) {
      if (mine !== generation) return
      viewerStore.set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  close() {
    generation += 1
    viewerStore.set({
      path: undefined,
      file: undefined,
      loading: false,
      error: undefined,
      line: undefined,
    })
  },

  /** Re-read what is open, after the agent has changed it underneath. */
  refresh() {
    const { path, line } = viewerStore.get()
    if (path) void viewer.open(path, line)
  },
}
