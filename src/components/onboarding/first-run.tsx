import { useEffect } from "react"
import { formatChord } from "@/extend/commands"
import { useSession } from "@/state/session"
import { setPref, usePrefs } from "@/state/prefs"
import { useTabs } from "@/state/tabs"
import { cn } from "@/lib/utils"
import { CheckIcon } from "lucide-react"

/**
 * The first few minutes.
 *
 * Not a carousel and not coach marks. A carousel is read once and remembered
 * never; coach marks arrive over an interface you have not seen yet and block
 * the thing they are pointing at. This is a short list of things that are true
 * or not true right now, each of which **completes by being done** — so it
 * teaches by getting out of the way rather than by being read.
 *
 * It appears on the empty transcript, where there is nothing to displace, and
 * it disappears for good the moment every line is ticked. Nothing here nags: a
 * checklist you cannot finish is worse than no checklist.
 */

interface Step {
  id: string
  title: string
  hint: string
  keys?: string
}

const STEPS: Step[] = [
  {
    id: "workspace",
    title: "Point it at your project",
    hint: "The agent works in one folder and can see everything in it.",
    keys: "mod+o",
  },
  {
    id: "ask",
    title: "Ask for a change",
    hint: "Describe what you want. It reads, edits, and runs things itself.",
    keys: "mod+l",
  },
  {
    id: "files",
    title: "Open a file by name",
    hint: "The project is browsable without leaving the conversation.",
    keys: "mod+p",
  },
  {
    id: "review",
    title: "Read what it changed",
    hint: "Every edit lands in the diff, where you can comment on a line.",
    keys: "mod+shift+d",
  },
]

export function FirstRun() {
  const done = usePrefs((prefs) => prefs.onboarded)
  const cwd = useSession((state) => state.meta?.cwd)
  const home = useSession((state) => state.platform)
  const messages = useSession((state) => state.messages.length)
  const tabs = useTabs((state) => state.tabs.length)
  const railMode = usePrefs((prefs) => prefs.railMode)
  const openDirs = usePrefs((prefs) => prefs.openDirs.length)
  const diffOpen = usePrefs((prefs) => prefs.autoOpenDiff)

  /**
   * Which steps are already true.
   *
   * Read from the app's actual state rather than from a record of what was
   * clicked: someone who opened a folder before ever seeing this list has done
   * that step, and telling them otherwise is the fastest way to make the whole
   * thing feel like decoration.
   */
  const complete: Record<string, boolean> = {
    workspace: Boolean(cwd) && !isHome(cwd, home),
    ask: messages > 0,
    files: railMode === "files" || openDirs > 0,
    review: diffOpen,
  }
  const remaining = STEPS.filter((step) => !complete[step.id])

  // Finished lists do not linger. Recording it means a later empty transcript
  // is just an empty transcript.
  useEffect(() => {
    if (!done && remaining.length === 0 && tabs > 0) setPref("onboarded", true)
  }, [done, remaining.length, tabs])

  if (done || remaining.length === 0) return null

  return (
    <div className="mt-7 w-full">
      <div className="flex items-center gap-2 pb-1.5">
        <span className="text-[11px] text-faint">Getting started</span>
        <span className="tabular text-[10.5px] text-faint/70">
          {STEPS.length - remaining.length}/{STEPS.length}
        </span>
        <button
          type="button"
          onClick={() => setPref("onboarded", true)}
          className="pressable ml-auto rounded px-1 text-[10.5px] text-faint hover:text-foreground"
        >
          Dismiss
        </button>
      </div>

      <div className="flex flex-col">
        {STEPS.map((step) => (
          <div
            key={step.id}
            className={cn(
              "flex items-start gap-2.5 border-b border-hairline py-2 last:border-b-0",
              complete[step.id] && "opacity-45"
            )}
          >
            <span
              className={cn(
                "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full",
                complete[step.id] ? "bg-foreground text-background" : "ring-1 ring-hairline"
              )}
            >
              {complete[step.id] ? <CheckIcon className="size-2.5" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[12.5px]",
                  complete[step.id] ? "text-faint line-through" : "text-foreground/90"
                )}
              >
                {step.title}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-faint">{step.hint}</p>
            </div>
            {step.keys ? (
              <span className="mt-[1px] flex shrink-0 gap-0.5">
                {formatChord(step.keys).map((key) => (
                  <kbd
                    key={key}
                    className="rounded border border-hairline bg-raised px-1 text-[10px] text-faint"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Whether the agent is pointed at a home directory rather than a project.
 *
 * Opening a folder is the step; starting in `~` because nothing else was
 * chosen is not doing it.
 */
function isHome(cwd: string | undefined, platform: string): boolean {
  if (!cwd) return true
  const depth = cwd.split("/").filter(Boolean).length
  return platform === "darwin" ? depth <= 2 : depth <= 1
}
