import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import type { FileContents, GitDiff } from "@/lib/types"

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
  /** Diffs on the center stage instead of a file, when set. */
  diff?: { title: string; diffs: GitDiff[]; note?: string }
}

export const viewerStore = createStore<ViewerState>({ loading: false })
export const useViewer = createHook(viewerStore)

/** Bumped per open so a slow read for a file you already closed cannot land. */
let generation = 0

export const viewer = {
  async open(path: string, line?: number) {
    if (!hasBridge()) return
    const mine = ++generation
    // Reopening the same file keeps the old text on screen while the fresh
    // read races in — no white flash, no skeleton for a file already read.
    const current = viewerStore.get()
    const sameFile = current.path === path
    viewerStore.set({
      path,
      line,
      loading: !sameFile,
      error: undefined,
      file: sameFile ? current.file : undefined,
      diff: undefined,
    })
    try {
      const file = await getMako().readFile(path)
      if (mine !== generation) return
      viewerStore.set({ file, loading: false })
      // Live from here: any writer — an agent mid-edit, a formatter, a
      // terminal — lands on screen without a manual reopen.
      void getMako().watchFile(path)
    } catch (error) {
      if (mine !== generation) return
      viewerStore.set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  /** Re-read what is open — in place, no flash. Used by the disk watcher
   * and by anything that knows the agent just wrote the file. */
  async refresh(path?: string) {
    if (!hasBridge()) return
    const current = viewerStore.get().path
    if (!current || (path && current !== path)) return
    path = current
    const mine = generation
    try {
      const file = await getMako().readFile(path)
      if (mine !== generation || viewerStore.get().path !== path) return
      viewerStore.set({ file })
    } catch {
      // A transient read failure mid-write resolves on the next event.
    }
  },

  /**
   * A diff, center stage. The inspector's pane is a few hundred pixels wide
   * — fine for glancing, wrong for reading a commit — so a diff opened from
   * history takes the transcript's space the way a file does, split view
   * and all, and Escape gives it back.
   */
  async openDiff(title: string, load: () => Promise<{ diffs: GitDiff[]; note?: string }>) {
    if (!hasBridge()) return
    const mine = ++generation
    viewerStore.set({ path: title, loading: true, error: undefined, file: undefined, diff: undefined })
    try {
      const { diffs, note } = await load()
      if (mine !== generation) return
      viewerStore.set({ diff: { title, diffs, note }, loading: false })
    } catch (error) {
      if (mine !== generation) return
      viewerStore.set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  close() {
    if (hasBridge()) void getMako().unwatchFile()
    generation += 1
    viewerStore.set({
      path: undefined,
      file: undefined,
      loading: false,
      error: undefined,
      line: undefined,
      diff: undefined,
    })
  },

}
