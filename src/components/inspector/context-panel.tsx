import { memo, useCallback, useMemo, useState } from "react"
import { Chip, Eyebrow } from "@/components/ui/kit"
import { touchedFiles, type FileAction, type TouchedFile } from "@/lib/context-files"
import { fileDir, fileName, formatContextWindow, formatRate, formatTokens } from "@/lib/format"
import { getMako } from "@/lib/bridge"
import { actions, shallowEqual, useSession } from "@/state/session"
import { cn } from "@/lib/utils"
import type { SkillSummary } from "@/lib/types"
import {
  BookOpenIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
} from "lucide-react"

/**
 * What the agent is working with right now.
 *
 * The question this panel answers is "why did it do that?" — which files it
 * has in hand, which skills it can reach for, which tools are live, and how
 * much of the context window is already spent.
 */
export function ContextPanel() {
  return (
    <div className="h-full overflow-y-auto overscroll-contain pb-4">
      <Budget />
      <Files />
      <Skills />
      <Tools />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* budget                                                              */
/* ------------------------------------------------------------------ */

function Budget() {
  const model = useSession((state) => state.meta?.model)
  const usage = useSession(
    useCallback(
      (state) => ({
        percent: state.meta?.context?.percent ?? null,
        tokens: state.meta?.context?.tokens ?? null,
        window: state.meta?.context?.contextWindow ?? state.meta?.model?.contextWindow ?? 0,
        cost: state.meta?.cost ?? 0,
        stats: state.meta?.tokens,
      }),
      []
    ),
    shallowEqual
  )

  if (!model) return null
  const percent = usage.percent ?? 0
  const tone = percent > 90 ? "bg-negative" : percent > 72 ? "bg-caution" : "bg-foreground/45"

  return (
    <section className="border-b border-hairline px-2.5 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[12.5px] font-medium">{model.name}</span>
        <span className="tabular shrink-0 text-[10.5px] text-faint">
          {formatRate(model.cost.input)}/{formatRate(model.cost.output)} per Mtok
        </span>
      </div>

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", tone)}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <div className="mt-1 flex items-baseline justify-between text-[10.5px] text-faint">
        <span className="tabular">
          {usage.tokens == null ? "—" : formatTokens(usage.tokens)} /{" "}
          {formatContextWindow(usage.window)} context
        </span>
        <span className="tabular">{usage.percent == null ? "" : `${Math.round(percent)}%`}</span>
      </div>

      {usage.stats && usage.stats.total > 0 ? (
        <div className="mt-2 grid grid-cols-3 gap-2 border-t border-hairline pt-2">
          <Stat label="in" value={formatTokens(usage.stats.input)} />
          <Stat label="out" value={formatTokens(usage.stats.output)} />
          <Stat label="cached" value={formatTokens(usage.stats.cacheRead)} />
        </div>
      ) : null}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="tabular truncate text-[12px] text-muted-foreground">{value}</div>
      <div className="text-[9.5px] text-faint">{label}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* files                                                               */
/* ------------------------------------------------------------------ */

const FILE_ICON = {
  read: FileTextIcon,
  edited: FilePenLineIcon,
  created: FilePlusIcon,
} satisfies Record<FileAction, typeof FileTextIcon>

const FILE_TONE = {
  read: "text-faint",
  edited: "text-caution",
  created: "text-added",
} satisfies Record<FileAction, string>

function Files() {
  const messages = useSession((state) => state.messages)
  const changed = useSession((state) => state.git?.files)

  const files = useMemo(() => touchedFiles(messages), [messages])
  const stats = useMemo(() => {
    const map = new Map<string, { insertions: number; deletions: number }>()
    for (const file of changed ?? []) {
      map.set(file.path, { insertions: file.insertions, deletions: file.deletions })
    }
    return map
  }, [changed])

  if (files.length === 0) return null

  return (
    <Section title="Files in play" count={files.length}>
      {files.map((file) => (
        <FileRow key={file.path} file={file} stat={stats.get(file.path)} />
      ))}
    </Section>
  )
}

const FileRow = memo(function FileRow({
  file,
  stat,
}: {
  file: TouchedFile
  stat?: { insertions: number; deletions: number }
}) {
  const Icon = FILE_ICON[file.action]
  return (
    <button
      type="button"
      title={`${file.path} · ${file.action}${file.count > 1 ? ` ${file.count}×` : ""}`}
      onClick={() => void getMako().revealPath(file.path)}
      className="contain-turn flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-100 hover:bg-fill-hover [contain-intrinsic-size:auto_26px]"
    >
      <Icon className={cn("size-3 shrink-0", FILE_TONE[file.action])} />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85">
        {fileName(file.path)}
        <span className="ml-1.5 text-[10px] text-faint">{fileDir(file.path)}</span>
      </span>
      {file.count > 1 ? (
        <span className="tabular shrink-0 text-[9.5px] text-faint">{file.count}×</span>
      ) : null}
      {stat ? (
        <span className="tabular shrink-0 text-[10px]">
          <span className="text-added">+{stat.insertions}</span>{" "}
          <span className="text-removed">−{stat.deletions}</span>
        </span>
      ) : null}
    </button>
  )
})

/* ------------------------------------------------------------------ */
/* skills                                                              */
/* ------------------------------------------------------------------ */

/**
 * What the agent can reach for.
 *
 * One line per skill. Skill descriptions are written to be read by a model —
 * they are long, they repeat their own trigger conditions, and there can be
 * twenty of them. Rendered in full they were the entire panel: a wall of grey
 * prose that buried the two sections anyone actually consults. The name is
 * what you scan for; the description is what you read once, on purpose.
 */
function Skills() {
  const skills = useSession((state) => state.capabilities.skills)
  const [open, setOpen] = useState<string>()
  if (skills.length === 0) return null

  return (
    <Section title="Skills" count={skills.length}>
      {skills.map((skill) => (
        <SkillRow
          key={skill.name}
          skill={skill}
          open={open === skill.name}
          onToggle={() => setOpen(open === skill.name ? undefined : skill.name)}
        />
      ))}
    </Section>
  )
}

const SkillRow = memo(function SkillRow({
  skill,
  open,
  onToggle,
}: {
  skill: SkillSummary
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="group contain-turn [contain-intrinsic-size:auto_24px]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors duration-100 hover:bg-fill-hover"
      >
        <BookOpenIcon className="size-3 shrink-0 text-faint" />
        <span className="shrink-0 text-[11.5px] text-foreground/90">
          <span className="text-faint">$</span>
          {skill.name}
        </span>
        {/* The description trails the name on the same line and is cut by the
            panel edge, so it hints at what this is without ever costing a
            second row. Opening one is a deliberate act. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[10.5px] text-faint",
            open && "opacity-0"
          )}
        >
          {skill.description}
        </span>
        <span
          role="presentation"
          title={`Insert $${skill.name} into the composer`}
          onClick={(event) => {
            event.stopPropagation()
            window.dispatchEvent(new CustomEvent("mako:insert", { detail: `$${skill.name} ` }))
          }}
          className="pressable shrink-0 rounded px-1 text-[10px] text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-foreground"
        >
          use
        </span>
      </button>
      {open ? (
        <p className="animate-thread px-1.5 pt-0.5 pb-1.5 pl-[26px] text-[11px] leading-relaxed text-muted-foreground">
          {skill.description}
        </p>
      ) : null}
    </div>
  )
})

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

function Tools() {
  const tools = useSession((state) => state.capabilities.tools)
  const [open, setOpen] = useState(false)

  const active = useMemo(() => tools.filter((tool) => tool.active).map((tool) => tool.name), [tools])
  if (tools.length === 0) return null

  const toggle = (name: string, on: boolean) =>
    void actions.setActiveTools(
      on ? [...active, name] : active.filter((entry) => entry !== name)
    )

  return (
    <section className="px-2.5 pt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 py-1 text-left"
      >
        <ChevronRightIcon
          className={cn("size-3 text-faint transition-transform duration-150", open && "rotate-90")}
        />
        <Eyebrow className="px-0">Tools</Eyebrow>
        <Chip className="ml-auto">
          {active.length}/{tools.length}
        </Chip>
      </button>

      {open ? (
        <div className="pt-1">
          {tools.map((tool) => (
            <button
              key={tool.name}
              type="button"
              role="switch"
              aria-checked={tool.active}
              onClick={() => toggle(tool.name, !tool.active)}
              title={tool.description}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-100 hover:bg-fill-hover"
            >
              <span
                className={cn(
                  "flex h-3 w-5 shrink-0 items-center rounded-full p-[2px] transition-colors duration-150",
                  tool.active ? "bg-foreground/60" : "bg-foreground/15"
                )}
              >
                <span
                  className={cn(
                    "block size-2 rounded-full bg-background [transition:transform_180ms_var(--ease-out)]",
                    tool.active ? "translate-x-2" : "translate-x-0"
                  )}
                />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[12px]",
                  tool.active ? "text-foreground/85" : "text-faint"
                )}
              >
                {tool.name}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------ */

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className="px-2.5 pt-3">
      <div className="flex items-center gap-2 pb-1">
        <Eyebrow className="px-0">{title}</Eyebrow>
        <span className="tabular text-[10px] text-faint">{count}</span>
      </div>
      {children}
    </section>
  )
}
