import { createHook, createStore } from "@/state/store"

type WorkspaceTransition =
  | { kind: "ready" }
  | { kind: "loading"; cwd: string }
  | { kind: "failed"; cwd: string; message: string }

export const workspaceTransitionStore = createStore<WorkspaceTransition>({
  kind: "ready",
})
export const useWorkspaceTransition = createHook(workspaceTransitionStore)
