import { useCallback, useRef, useSyncExternalStore } from "react"

/**
 * A ~40-line observable store.
 *
 * The point is the read path: components subscribe through a selector and
 * re-render only when *their* slice changes identity. A token arriving on the
 * streaming message therefore wakes the one component rendering it, not the
 * transcript, the rail, or the inspector.
 */

export interface Store<T> {
  get: () => T
  set: (patch: Partial<T> | ((state: T) => Partial<T>)) => void
  subscribe: (listener: () => void) => () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()

  return {
    get: () => state,
    set: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch
      let changed = false
      for (const key of Object.keys(next) as (keyof T)[]) {
        if (!Object.is(state[key], next[key])) {
          changed = true
          break
        }
      }
      if (!changed) return
      state = { ...state, ...next }
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.is(left[key], right[key]))
}

/** Bind a store slice to React. `isEqual` defaults to reference identity. */
export function createHook<T extends object>(store: Store<T>) {
  return function useSlice<S>(selector: (state: T) => S, isEqual: (a: S, b: S) => boolean = Object.is): S {
    const cache = useRef<{ value: S; source: T } | null>(null)

    const getSnapshot = useCallback(() => {
      const source = store.get()
      const previous = cache.current
      if (previous && previous.source === source) return previous.value
      const value = selector(source)
      if (previous && isEqual(previous.value, value)) {
        cache.current = { value: previous.value, source }
        return previous.value
      }
      cache.current = { value, source }
      return value
      // The selector is expected to be stable (module scope or useCallback).
    }, [selector, isEqual])

    return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
  }
}
