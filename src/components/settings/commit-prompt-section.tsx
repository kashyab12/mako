import { useEffect, useState } from "react"
import { Action, Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { getMako, hasBridge } from "@/lib/bridge"
import { setPref, usePrefs } from "@/state/prefs"
import type { ModelInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import { RotateCcwIcon } from "lucide-react"

export function CommitPromptSection() {
  const stored = usePrefs((prefs) => prefs.commitPrompt)
  const commitModel = usePrefs((prefs) => prefs.commitModel)
  const [fallback, setFallback] = useState("")
  const [models, setModels] = useState<ModelInfo[]>([])
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? stored ?? fallback
  const customized = Boolean(stored && stored !== fallback)

  useEffect(() => {
    if (!hasBridge()) return
    void getMako()
      .defaultCommitPrompt()
      .then(setFallback)
      .catch(() => setFallback(""))
    void getMako()
      .listModels()
      .then(setModels)
      .catch(() => setModels([]))
  }, [])

  return (
    <div className="flex flex-col gap-1">
      <p className="px-0.5 pb-1.5 text-label leading-relaxed text-faint">
        The instructions used when drafting a commit message from the diff. The
        default is the prompt Zed ships, which is well tuned; edit it to change
        the house style.
      </p>

      <label className="mb-2 flex items-center gap-3 rounded-lg bg-surface px-2.5 py-2 ring-1 ring-hairline">
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium text-foreground">
            Drafting model
          </span>
          <span className="block text-label text-faint">
            Automatic prefers a small capable model and does not spend conversation context.
          </span>
        </span>
        <select
          value={commitModel ?? "auto"}
          onChange={(event) =>
            setPref(
              "commitModel",
              event.target.value === "auto" ? undefined : event.target.value
            )
          }
          className="h-7 max-w-56 rounded-md bg-raised px-2 text-ui text-foreground ring-1 ring-hairline focus:outline-none focus-visible:ring-border"
        >
          <option value="auto">Automatic · cheap</option>
          <option value="current">Current conversation</option>
          {models.map((model) => (
            <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
              {model.name} · {model.provider}
            </option>
          ))}
        </select>
      </label>

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
