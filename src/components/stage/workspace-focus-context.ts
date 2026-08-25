import { createContext, useContext } from "react"

export interface WorkspaceFocus {
  cwd?: string
  title?: string
  identity: string
  ready: boolean
}

export const WorkspaceFocusContext = createContext<WorkspaceFocus>({
  identity: "none",
  ready: true,
})

export function workspaceFocusOf({
  sessionCwd,
  sessionTitle,
  viewing,
  live,
  liveThreadPath,
}: {
  sessionCwd?: string
  sessionTitle?: string
  viewing?: { path: string; cwd?: string; title?: string }
  live?: { id: string; cwd: string; title?: string }
  liveThreadPath?: string
}): WorkspaceFocus {
  const viewingOwnsFocus = Boolean(
    viewing && (!live || viewing.path !== liveThreadPath)
  )
  const cwd = viewingOwnsFocus ? viewing?.cwd : live?.cwd ?? sessionCwd
  const title = viewingOwnsFocus
    ? viewing?.title
    : live?.title ?? sessionTitle
  const identity = viewingOwnsFocus
    ? `thread:${viewing?.path}`
    : live
      ? `live:${live.id}`
      : `workspace:${sessionCwd ?? "none"}`
  return { cwd, title, identity, ready: !cwd || cwd === sessionCwd }
}

export function useWorkspaceFocus() {
  return useContext(WorkspaceFocusContext)
}
