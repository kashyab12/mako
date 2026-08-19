import { useEffect, useState } from "react"
import { Action, Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { getMako, hasBridge } from "@/lib/bridge"
import { setPref, usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { RotateCcwIcon } from "lucide-react"

export function CommitPromptSection() {
  const stored = usePrefs((prefs) => prefs.commitPrompt)
  const [fallback, setFallback] = useState("")
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? stored ?? fallback
  const customized = Boolean(stored && stored !== fallback)

  useEffect(() => {
    if (!hasBridge()) return
    void getMako()
      .defaultCommitPrompt()
      .then(setFallback)
      .catch(() => setFallback(""))
  }, [])

  return (
    <div className="flex flex-col gap-1">
      <p className="px-0.5 pb-1.5 text-label leading-relaxed text-faint">
        The instructions used when drafting a commit message from the diff. The
        default is the prompt Zed ships, which is well tuned; edit it to change
        the house style.
      </p>

      <textarea
        value={value}
        spellCheck={false}
        rows={18}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null)
            setPref("commitPrompt", draft.trim() ? draft : undefined)
          setDraft(null)
        }}
        className={cn(
          "w-full resize-y rounded-lg bg-raised px-2.5 py-2 font-mono text-ui leading-relaxed",
          "ring-1 ring-hairline focus:outline-none focus-visible:ring-border"
        )}
      />

      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-label text-faint">
          {customized ? "Customized" : "Using the default"}
        </span>
        <Action
          tone="ghost"
          size="xs"
          className="ml-auto"
          disabled={!customized}
          onClick={() => {
            setDraft(fallback)
            setPref("commitPrompt", undefined)
          }}
        >
          <RotateCcwIcon />
          Restore default
        </Action>
        <span className="flex items-center gap-1 text-label text-faint">
          <Keys keys={formatChord("mod+shift+g")} /> drafts
        </span>
      </div>
    </div>
  )
}
