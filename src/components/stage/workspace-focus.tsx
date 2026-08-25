import { useEffect, type ReactNode } from "react"
import {
  WorkspaceFocusContext,
  workspaceFocusOf,
} from "@/components/stage/workspace-focus-context"
import { useAcp } from "@/state/acp"
import { actions, useSession } from "@/state/session"
import { useThreads } from "@/state/threads"

export function WorkspaceFocusProvider({ children }: { children: ReactNode }) {
  const sessionCwd = useSession((state) => state.meta?.cwd)
  const sessionTitle = useSession((state) => state.meta?.sessionName)
  const viewing = useThreads((state) => state.viewing?.ref)
  const live = useAcp((state) => state.session)
  const liveThreadPath = useAcp((state) => state.threadPath)
  const focus = workspaceFocusOf({
    sessionCwd,
    sessionTitle,
    viewing,
    live: live ?? undefined,
    liveThreadPath,
  })

  useEffect(() => {
    if (focus.cwd && !focus.ready) void actions.openWorkspace(focus.cwd)
  }, [focus.cwd, focus.ready])

  return (
    <WorkspaceFocusContext.Provider value={focus}>
      {children}
    </WorkspaceFocusContext.Provider>
  )
}
