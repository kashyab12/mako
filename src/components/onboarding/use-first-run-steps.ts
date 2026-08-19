import { useEffect } from "react"
import { runCommand } from "@/extend/commands"
import { useSession } from "@/state/session"
import { setPref, usePrefs } from "@/state/prefs"
import { useTabs } from "@/state/tabs"
import { useViewer } from "@/state/viewer"

/**
 * The first few minutes, as state.
 *
 * Each step is true or not true *right now*, read from the app's actual
 * state rather than from a record of what was clicked: someone who opened a
 * folder before ever seeing the list has done that step. Latching lives in
 * state/onboarding.ts watching the stores directly, so a step done while no
 * onboarding UI is mounted still counts. Every step also knows how to run —
 * through the command registry, never a copied handler.
 */

export type StepId = "provider" | "workspace" | "ask" | "files" | "review"

export interface FirstRunStep {
  id: StepId
  title: string
  hint: string
  keys?: string
  done: boolean
  run: () => void
}

const STEPS: Array<Omit<FirstRunStep, "done" | "run"> & { command?: string }> = [
  {
    id: "provider",
    title: "Connect an agent",
    hint: "Mako uses your existing Claude Code, Codex, Cursor, Grok, or Devin login.",
  },
  {
    id: "workspace",
    title: "Point it at your project",
    hint: "The agent works in one folder and can see everything in it.",
    keys: "mod+o",
    command: "workspace.open",
  },
  {
    id: "ask",
    title: "Ask for a change",
    hint: "Describe what you want. It reads, edits, and runs things itself.",
    keys: "mod+l",
    command: "session.focus-composer",
  },
  {
    id: "files",
    title: "Open a file by name",
    hint: "The project is browsable without leaving the conversation.",
    keys: "mod+p",
    command: "view.quick-open",
  },
  {
    id: "review",
    title: "Read what it changed",
    hint: "Every edit lands in the diff, where you can comment on a line.",
    keys: "mod+shift+d",
    command: "view.toggle-diff",
  },
]

export interface FirstRunState {
  steps: FirstRunStep[]
  remaining: number
  finished: boolean
  dismiss: () => void
}

export function useFirstRunSteps(): FirstRunState {
  const done = usePrefs((prefs) => prefs.onboarded)
  const cwd = useSession((state) => state.meta?.cwd)
  const home = useSession((state) => state.platform)
  const messages = useSession((state) => state.messages.length)
  const tabs = useTabs((state) => state.tabs.length)
  const railMode = usePrefs((prefs) => prefs.railMode)
  const openDirs = usePrefs((prefs) => prefs.openDirs.length)
  const diffOpen = usePrefs((prefs) => prefs.autoOpenDiff)
  const latched = usePrefs((prefs) => prefs.onboardedSteps)
  const viewedFile = useViewer((state) => Boolean(state.path))

  const now = {
    provider: false,
    workspace: Boolean(cwd) && !isHome(cwd, home),
    ask: messages > 0,
    // Opening a file by name counts — that is what the step teaches — and
    // so does browsing the tree.
    files: viewedFile || railMode === "files" || openDirs > 0,
    review: diffOpen,
  } satisfies Record<StepId, boolean>

  const steps: FirstRunStep[] = STEPS.map((step) => {
    const command = step.command
    return {
      id: step.id,
      title: step.title,
      hint: step.hint,
      keys: step.keys,
      done: latched.includes(step.id) || now[step.id],
      run: command
        ? () => runCommand(command)
        : () =>
            window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" })),
    }
  })

  const remaining = steps.filter((step) => !step.done).length

  // Finished lists do not linger. Recording it means a later empty
  // transcript is just an empty transcript.
  useEffect(() => {
    if (!done && remaining === 0 && tabs > 0) setPref("onboarded", true)
  }, [done, remaining, tabs])

  return {
    steps,
    remaining,
    finished: done || remaining === 0,
    dismiss: () => setPref("onboarded", true),
  }
}

/**
 * Whether the agent is pointed at a home directory rather than a project.
 * Opening a folder is the step; starting in `~` because nothing else was
 * chosen is not doing it.
 */
function isHome(cwd: string | undefined, platform: string): boolean {
  if (!cwd) return true
  const depth = cwd.split("/").filter(Boolean).length
  return platform === "darwin" ? depth <= 2 : depth <= 1
}
