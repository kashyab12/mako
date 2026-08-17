import { useSyncExternalStore } from "react"

/**
 * A versioned registry. Registration returns a disposer; React reads through
 * `useVersion()` so a late-loading extension re-renders the surfaces that
 * consume it without anyone wiring a context.
 */
export class Registry<T> {
  private items = new Map<string, T>()
  private listeners = new Set<() => void>()
  private version = 0

  register(id: string, item: T): () => void {
    this.items.set(id, item)
    this.bump()
    return () => {
      if (this.items.get(id) === item) {
        this.items.delete(id)
        this.bump()
      }
    }
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  list(): T[] {
    return [...this.items.values()]
  }

  entries(): Array<[string, T]> {
    return [...this.items.entries()]
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = () => this.version

  private bump() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

/** Re-render on any change to the registry. */
export function useRegistry<T>(registry: Registry<T>): Registry<T> {
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion)
  return registry
}
