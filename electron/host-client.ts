import { AsyncLocalStorage } from "node:async_hooks"

const clients = new AsyncLocalStorage<string>()

export function hostClient(): string {
  return clients.getStore() ?? "app"
}

export function withHostClient<Result>(id: string, run: () => Result): Result {
  return clients.run(id, run)
}
