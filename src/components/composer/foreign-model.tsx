import { useCallback, useEffect, useMemo, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Eyebrow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import {
  harnessDefault,
  rememberHarnessDefault,
  setComposerTuning,
  threadsStore,
  useThreads,
} from "@/state/threads"
import { getMako, hasBridge } from "@/lib/bridge"
import { fuzzy } from "@/lib/fuzzy"
import { cn } from "@/lib/utils"
import { harnessModelByIdentity } from "@/lib/types"
import type { HarnessModel, HarnessProfile } from "@/lib/types"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

export function ForeignModelPicker({ harness }: { harness: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [profile, setProfile] = useState<HarnessProfile | null>(null)
  const chosen = useThreads((state) => state.composerTuning[harness]?.model)

  const load = useCallback(() => {
    if (!hasBridge()) return
    void getMako()
      .harnessTuning(harness)
      .then((next) => {
        setProfile(next)
        rememberHarnessDefault(harness, {
          model: next.configuredModel ?? next.defaultModel,
        })
        const current = threadsStore.get().composerTuning[harness]?.model
        if (!current) return
        const canonical = harnessModelByIdentity(next, current)
        if (canonical?.id !== current) {
          setComposerTuning(harness, {
            model: canonical?.id,
            effort: undefined,
            fast: undefined,
            options: undefined,
          })
        }
      })
      .catch(() => {})
  }, [harness])

  useEffect(() => {
    load()
  }, [load])

  const inherited = profile
    ? harnessModelByIdentity(
        profile,
        profile.configuredModel ?? profile.defaultModel
      )?.id
    : harnessDefault(harness).model
  const effective = harnessModelByIdentity(profile ?? undefined, chosen)?.id ?? inherited
  const selected = harnessModelByIdentity(profile ?? undefined, effective)
  const models = useMemo(() => rankModels(profile?.models ?? [], query), [profile?.models, query])

  const set = (model?: string) => {
    setComposerTuning(harness, {
      model,
      effort: undefined,
      fast: undefined,
      options: undefined,
    })
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) load()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${selected?.label ?? effective ?? "Provider setting"}`}
          className={cn(
            "pressable no-drag flex h-7 min-w-0 max-w-[15rem] items-center gap-1.5 rounded-md px-2",
            "text-[12.5px] font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-raised aria-expanded:bg-raised"
          )}
        >
          <HarnessIcon harness={harness} className="size-3.5" />
          <span className="truncate">{selected?.label ?? effective ?? "Provider setting"}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[23rem] gap-0 p-0">
        <div className="border-b border-hairline px-2 pt-2 pb-1.5">
          <Eyebrow className="px-0.5 pb-1">{harnessLabel(harness)} models</Eyebrow>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            className="h-7 w-full rounded-md bg-raised px-2 text-[11.5px] placeholder:text-faint focus:outline-none"
          />
        </div>
        <div className="max-h-[20rem] overflow-y-auto overscroll-contain p-1">
          {models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              selected={effective === model.id}
              inherited={!chosen && effective === model.id}
              onChoose={() => set(model.id)}
            />
          ))}
          {profile && models.length === 0 ? (
            <p className="px-2 py-5 text-center text-[11.5px] text-faint">No models match.</p>
          ) : null}
        </div>
        <div className="flex items-center justify-between border-t border-hairline px-2 py-1.5 text-[10.5px] text-faint">
          <span>{profile?.models.length ?? 0} models reported by the provider</span>
          {chosen ? (
            <button type="button" onClick={() => set(undefined)} className="pressable rounded px-1 hover:text-foreground">
              Use provider setting
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ModelRow({
  model,
  selected,
  inherited,
  onChoose,
}: {
  model: HarnessModel
  selected: boolean
  inherited: boolean
  onChoose: () => void
}) {
  const optionSummary = model.options
    .map((option) =>
      option.kind === "boolean"
        ? option.label
        : `${option.values.length} ${option.label.toLowerCase()} levels`
    )
    .join(" · ")
  return (
    <button
      type="button"
      onClick={onChoose}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors duration-100",
        selected ? "bg-raised" : "hover:bg-raised/60"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12.5px]", selected ? "font-medium text-foreground" : "text-foreground/90")}>
          {model.label}
          {inherited ? <span className="ml-1.5 text-[10px] font-normal text-faint">provider setting</span> : null}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-faint">
          {model.id}
        </span>
        {model.description || optionSummary ? (
          <span className="mt-0.5 block truncate text-[10.5px] text-faint/80">
            {model.description || optionSummary}
          </span>
        ) : null}
      </span>
      {model.contextWindow ? (
        <span className="shrink-0 text-[10px] text-faint">{Math.round(model.contextWindow / 1000)}K context</span>
      ) : null}
      {selected ? <CheckIcon className="size-3.5 shrink-0 text-brand" /> : null}
    </button>
  )
}

function rankModels(models: HarnessModel[], query: string): HarnessModel[] {
  const term = query.trim()
  if (!term) return models
  return models
    .flatMap((model) => {
      const match = fuzzy(
        term,
        `${model.label} ${model.id} ${model.launchId ?? ""} ${(model.aliases ?? []).join(" ")} ${model.description ?? ""}`
      )
      return match ? [{ model, score: match.score }] : []
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.model)
}
