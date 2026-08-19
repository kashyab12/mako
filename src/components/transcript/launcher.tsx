import { Keys } from "@/components/ui/kit"
import { formatChord, runCommand } from "@/extend/commands"
import { useFirstRunSteps } from "@/components/onboarding/use-first-run-steps"
import { cn } from "@/lib/utils"
import {
  CheckIcon,
  CircleCheckIcon,
  FileSearchIcon,
  GitCompareIcon,
  MapIcon,
  type LucideIcon,
} from "lucide-react"

/**
 * The empty transcript's launcher: one column of things worth doing next,
 * each an action with its chord — never an illustration of emptiness.
 *
 * Until onboarding finishes it shows the getting-started steps, and every
 * row *does* the step rather than describing it, running the registered
 * command so the list can never drift from what the keys actually do. Once
 * onboarded, the same rows become concrete openers that fill the composer —
 * the first message is still the user's.
 */
export function Launcher() {
  const { steps, remaining, finished, dismiss } = useFirstRunSteps()

  if (!finished && remaining > 0) {
    return (
      <div className="mt-6 w-full">
        <div className="flex items-center gap-2 pb-1.5">
          <span className="text-label text-faint">Getting started</span>
          <span className="tabular text-label text-faint/70">
            {steps.length - remaining}/{steps.length}
          </span>
          <button
            type="button"
            onClick={dismiss}
            className="pressable ml-auto rounded px-1 text-label text-faint hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
        <div className="flex flex-col gap-0.5">
          {steps.map((step, index) => {
            const isNext = steps.find((entry) => !entry.done)?.id === step.id
            return (
              <LauncherRow
                key={step.id}
                index={index}
                title={step.title}
                hint={isNext ? step.hint : undefined}
                keys={step.keys ? formatChord(step.keys) : undefined}
                done={step.done}
                onRun={step.run}
              />
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6 flex flex-col gap-0.5">
      {SUGGESTIONS.map((suggestion, index) => (
        <LauncherRow
          key={suggestion.text}
          index={index}
          icon={suggestion.icon}
          title={suggestion.text}
          onRun={() =>
            window.dispatchEvent(
              new CustomEvent("mako:compose", { detail: suggestion.text })
            )
          }
        />
      ))}
      <LauncherRow
        index={SUGGESTIONS.length}
        icon={FileSearchIcon}
        title="Open a file by name"
        keys={formatChord("mod+p")}
        onRun={() => runCommand("view.quick-open")}
      />
    </div>
  )
}

const SUGGESTIONS: Array<{ text: string; icon: LucideIcon }> = [
  { text: "Explain how this project is structured", icon: MapIcon },
  { text: "Review my uncommitted changes", icon: GitCompareIcon },
  { text: "Find and fix the failing test", icon: CircleCheckIcon },
]

function LauncherRow({
  index,
  icon: Icon,
  title,
  hint,
  keys,
  done,
  onRun,
}: {
  index: number
  icon?: LucideIcon
  title: string
  hint?: string
  keys?: string[]
  done?: boolean
  onRun: () => void
}) {
  return (
    <button
      type="button"
      // A short stagger on first paint; the list reads as arriving rather
      // than as having always been there. 45ms stays under the threshold
      // where waiting becomes perceptible.
      style={{ animationDelay: `${60 + index * 45}ms` }}
      onClick={onRun}
      className={cn(
        "pressable group flex h-9 w-full animate-enter items-center gap-2.5 rounded-md px-2.5",
        "text-left text-ui text-muted-foreground",
        "[transition:transform_var(--duration-press)_var(--ease-out),color_120ms_ease,background-color_120ms_ease]",
        "hover:bg-fill-hover hover:text-foreground",
        done && "opacity-45"
      )}
    >
      {done !== undefined ? (
        <span
          className={cn(
            "flex size-3.5 shrink-0 items-center justify-center rounded-full",
            done ? "bg-foreground text-background" : "ring-1 ring-hairline"
          )}
        >
          {done ? <CheckIcon className="size-2.5" /> : null}
        </span>
      ) : Icon ? (
        <Icon className="size-3.5 shrink-0 text-faint transition-colors duration-100 group-hover:text-foreground/80" />
      ) : null}
      <span className={cn("min-w-0 flex-1 truncate", done && "text-faint line-through")}>
        {title}
        {hint ? <span className="pl-2 text-label text-faint">{hint}</span> : null}
      </span>
      {keys ? <Keys keys={keys} /> : null}
    </button>
  )
}
