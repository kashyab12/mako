import { createHook, createStore } from "@/state/store"

type HostConnection =
  { kind: "connected" } | { kind: "disconnected"; message: string }
export const hostConnectionStore = createStore<HostConnection>({
  kind: "connected",
})
export const useHostConnection = createHook(hostConnectionStore)
