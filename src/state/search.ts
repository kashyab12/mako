import { createHook, createStore } from "@/state/store"
import { getPi, hasBridge } from "@/lib/bridge"
import type { SearchOptions, SearchResults } from "@/lib/types"

/**
 * Global search.
 *
 * Runs against the host rather than in here: `git grep` over a checkout beats
 * anything a renderer can do to the same corpus, and reading a few hundred
 * session files has no business happening on the thread that draws the window.
 *
 * Not debounced by a timer but by a generation counter — a query that returns
 * after you have typed further is discarded rather than flashing stale results
 * on screen, which is the failure people actually notice.
 */

export interface SearchState {
  open: boolean
  query: string
  options: SearchOptions
  results?: SearchResults
  running: boolean
}

const defaults: SearchOptions = { regex: false, caseSensitive: false, wholeWord: false, threads: true }

export const searchStore = createStore<SearchState>({
  open: false,
  query: "",
  options: defaults,
  running: false,
})

export const useSearch = createHook(searchStore)

let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * A pause before the sweep.
 *
 * Long enough that typing a word does not start six searches, short enough to
 * feel like it is keeping up. Every keystroke restarts it; the counter, not the
 * timer, is what guarantees the answer on screen matches the box.
 */
const DEBOUNCE_MS = 180

function parseSearchFailure(query: string, cause: unknown): SearchResults {
  return {
    query,
    files: [],
    threads: [],
    total: 0,
    truncated: false,
    elapsed: 0,
    error: cause instanceof Error ? cause.message : String(cause),
  }
}

function run(query: string, options: SearchOptions) {
  const mine = ++generation
  const term = query.trim()
  if (term.length < 2) {
    searchStore.set({ results: undefined, running: false })
    return
  }
  searchStore.set({ running: true })
  void getPi()
    .search(term, options)
    .then((results) => {
      if (mine !== generation) return
      searchStore.set({ results, running: false })
    })
    .catch((cause: unknown) => {
      if (mine !== generation) return
      searchStore.set({ running: false, results: parseSearchFailure(term, cause) })
    })
}

function schedule() {
  clearTimeout(timer)
  const { query, options } = searchStore.get()
  timer = setTimeout(() => run(query, options), DEBOUNCE_MS)
}

export const search = {
  open(seed?: string) {
    if (!hasBridge()) return
    searchStore.set({ open: true })
    if (seed !== undefined) search.setQuery(seed)
  },

  close() {
    clearTimeout(timer)
    generation += 1
    searchStore.set({ open: false, running: false })
  },

  setQuery(query: string) {
    searchStore.set({ query })
    schedule()
  },

  toggle(key: keyof SearchOptions) {
    const options = searchStore.get().options
    searchStore.set({ options: { ...options, [key]: !options[key] } })
    // A changed switch re-runs immediately: you flipped it to see the effect.
    clearTimeout(timer)
    const { query } = searchStore.get()
    run(query, searchStore.get().options)
  },
}
