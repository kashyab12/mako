import { useEffect, useState } from "react"
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react"
import { Action, Eyebrow } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import type { SkillSyncTarget } from "@/lib/types"
import { skills, useSkills } from "@/state/skills"

export function SkillsSection() {
  const state = useSkills((value) => value)
  const [targets, setTargets] = useState<SkillSyncTarget[]>([])
  const [scope, setScope] = useState<"user" | "workspace">("user")
  const [query, setQuery] = useState("")

  useEffect(() => {
    void skills.load()
  }, [])

  const snapshot = state.snapshot
  const term = query.trim().toLowerCase()
  const shown = snapshot?.skills.filter(
    (skill) =>
      !term ||
      skill.name.toLowerCase().includes(term) ||
      skill.description.toLowerCase().includes(term) ||
      skill.origins.some((origin) =>
        `${origin.provider} ${origin.scope}`.includes(term)
      )
  ) ?? []
  const toggleTarget = (target: SkillSyncTarget) => {
    setTargets((current) =>
      current.some((candidate) => sameTarget(candidate, target))
        ? current.filter((candidate) => !sameTarget(candidate, target))
        : [...current, target]
    )
  }

  return (
    <div>
      <p className="pb-3 text-ui leading-relaxed text-muted-foreground">
        Agent Skills share one portable core: a skill directory with SKILL.md,
        name and description frontmatter, plus optional scripts, references,
        and assets. Mako discovers universal and provider-specific roots and
        compares complete package hashes. Sync installs into the selected
        provider root, so that skill is also available when the provider runs
        outside Mako; every write requires a preview.
      </p>

      {state.status === "loading" && !snapshot ? (
        <p className="shimmer text-ui text-faint">Reading skill roots…</p>
      ) : null}

      {snapshot ? (
        <>
          <div className="flex items-center justify-between pt-2 pb-1">
            <Eyebrow className="px-0">Targets</Eyebrow>
            <span className="flex rounded-md bg-raised p-0.5 text-label">
              {(["user", "workspace"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setScope(value)
                    setTargets([])
                  }}
                  className={cn(
                    "pressable rounded px-1.5 py-0.5",
                    scope === value
                      ? "bg-surface text-foreground"
                      : "text-faint hover:text-foreground"
                  )}
                >
                  {value === "user" ? "All projects" : "This project"}
                </button>
              ))}
            </span>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {snapshot.providers.map((provider) => {
              const target: SkillSyncTarget = {
                provider: provider.id,
                account: provider.account,
                scope,
              }
              const selected = targets.some((candidate) =>
                sameTarget(candidate, target)
              )
              return (
                <label
                  key={`${provider.id}:${provider.account}`}
                  className={cn(
                    "flex items-center gap-2 rounded-md bg-surface px-2.5 py-2 text-ui ring-1 ring-hairline",
                    provider.available ? "cursor-pointer" : "opacity-50"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!provider.available}
                    onChange={() => toggleTarget(target)}
                    className="size-3 accent-current"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {provider.label}
                  </span>
                  <span className="text-label text-faint">
                    {provider.available ? provider.account : "not found"}
                  </span>
                </label>
              )
            })}
          </div>

          <div className="mb-2 flex items-center gap-2">
            <Eyebrow className="flex-1 px-0">Discovered skills</Eyebrow>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter skills"
              className="h-7 w-48 rounded-md bg-surface px-2 text-label text-foreground ring-1 ring-hairline placeholder:text-faint focus:ring-border focus:outline-none"
            />
          </div>
          <div className="flex flex-col rounded-lg bg-surface ring-1 ring-hairline">
            {shown.map((skill) => {
              const previews = state.previews[skill.id] ?? []
              const previewsCurrent =
                previews.length === targets.length &&
                previews.every((preview) =>
                  targets.some((target) => sameTarget(preview.target, target))
                )
              const actionable = previewsCurrent
                ? previews.filter((preview) =>
                    ["add", "replace", "remove"].includes(preview.action)
                  )
                : []
              return (
                <div
                  key={skill.id}
                  className={cn(
                    "contain-turn flex gap-2.5 border-b border-hairline px-2.5 py-2.5 last:border-b-0",
                    !skill.portable && "opacity-60"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-ui">{skill.name}</span>
                      <span className="rounded bg-raised px-1 py-0.5 text-label text-faint">
                        {formatBytes(skill.bytes)} · {skill.files}{" "}
                        {skill.files === 1 ? "file" : "files"}
                      </span>
                      {skill.conflict ? (
                        <span className="flex items-center gap-1 text-label text-caution">
                          <AlertTriangleIcon className="size-3" /> choose a
                          definition
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-label leading-relaxed text-muted-foreground">
                      {skill.description}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-x-2 text-label text-faint">
                      {skill.origins.map((origin) => (
                        <span key={`${origin.provider}:${origin.provenance}`}>
                          {origin.provider} · {origin.scope}
                        </span>
                      ))}
                      <span>hash {skill.hash.slice(0, 8)}</span>
                      {skill.license ? <span>{skill.license}</span> : null}
                      {skill.blockReason ? (
                        <span>{skill.blockReason}</span>
                      ) : null}
                    </span>
                    {previewsCurrent && previews.length ? (
                      <span className="mt-1.5 block text-label text-muted-foreground">
                        {previews.map((preview) => preview.summary).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-start gap-1.5">
                    <Action
                      tone="outline"
                      disabled={
                        !skill.portable ||
                        targets.length === 0 ||
                        state.status === "syncing"
                      }
                      onClick={() =>
                        void skills.preview(skill.id, targets, "sync")
                      }
                    >
                      Preview sync
                    </Action>
                    <Action
                      tone="outline"
                      disabled={
                        targets.length === 0 || state.status === "syncing"
                      }
                      onClick={() =>
                        void skills.preview(skill.id, targets, "remove")
                      }
                    >
                      Preview remove
                    </Action>
                    {actionable.length ? (
                      <Action
                        disabled={state.status === "syncing"}
                        onClick={() => void skills.apply(skill.id)}
                      >
                        Apply {actionable.length}
                      </Action>
                    ) : null}
                  </span>
                </div>
              )
            })}
            {shown.length === 0 ? (
              <p className="px-3 py-8 text-center text-ui text-faint">
                {snapshot.skills.length === 0
                  ? "No Agent Skills were found in global or project roots."
                  : "No skills match this filter."}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-2 pt-3">
            <Action
              tone="outline"
              disabled={state.status === "loading"}
              onClick={() => void skills.load()}
            >
              <RefreshCwIcon className="size-3" />
              Refresh
            </Action>
            <span className="text-label text-faint">
              Replacements and removals move the prior package into a hidden
              Mako backup directory beside the provider root.
            </span>
          </div>
        </>
      ) : null}

      {state.error ? (
        <p className="pt-2 text-label text-removed">{state.error}</p>
      ) : null}
    </div>
  )
}

function sameTarget(left: SkillSyncTarget, right: SkillSyncTarget): boolean {
  return (
    left.provider === right.provider &&
    left.account === right.account &&
    left.scope === right.scope
  )
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`
}
