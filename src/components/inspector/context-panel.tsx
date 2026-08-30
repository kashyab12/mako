import { memo, useMemo, useState } from "react"
import { Chip, Eyebrow, ListCard } from "@/components/ui/kit"
import { contextAccounting } from "@/lib/context-accounting"
import { touchedFiles, type FileAction, type TouchedFile } from "@/lib/context-files"
import { fileDir, fileName, formatContextWindow, formatCost, formatRate, formatTokens } from "@/lib/format"
import { threadToMessages } from "@/lib/foreign-thread"
import { acpBlocksToMessages } from "@/lib/acp-blocks"
import { activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { useProviders } from "@/state/providers"
import { actions, useSession } from "@/state/session"
import { useThreads } from "@/state/threads"
import { cn } from "@/lib/utils"
import { viewer } from "@/state/viewer"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
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
 * The question this surface answers is "why did it do that?" — which files
 * it has in hand, which skills it can reach for, which tools are live, and
 * how much of the context window is already spent. Laid out the way
 * OpenCode lays out its context tab: a reading column, a labelled stat
 * grid, one stacked bar for where the tokens went, and the lists grouped
 * into cards — because this renders on a full card now, not in a 400px
 * column.
 */
const EMPTY_BLOCKS: never[] = []

export function ContextPanel() {
  const viewing = useThreads((state) => state.viewing)
  const acpSession = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const acpStarting = useAcp((state) => activeAcp(state)?.kind === "starting")
  const builtin = !viewing && !acpSession && !acpStarting
  return (
    <div className="h-full overflow-y-auto overscroll-contain [container-type:inline-size]">
      <div className="mx-auto flex w-full max-w-content flex-col gap-7 px-6 py-6">
        <Budget />
        <Files />
        {builtin ? (
          <>
            <Skills />
            <Tools />
          </>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* budget                                                              */
/* ------------------------------------------------------------------ */

function Budget() {
  const meta = useSession((state) => state.meta)
  const viewing = useThreads((state) => state.viewing)
  const composerHarness = useThreads((state) => state.composerHarness)
  const acpSession = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const acpStarting = useAcp((state) => activeAcp(state)?.kind === "starting")
  const profiles = useProviders((state) => state.profiles)
  const usage = contextAccounting({
    meta,
    viewing,
    acpSession,
    acpStarting,
    composerHarness,
    profiles,
  })
  const stats: Array<{ label: string; value: string }> = []

  if (usage.kind === "exact") {
    if (!meta?.model) return null
    stats.push(
      { label: "model", value: meta.model.name },
      {
        label: "price per Mtok",
        value: `${formatRate(meta.model.cost.input)} in · ${formatRate(meta.model.cost.output)} out`,
      },
      { label: "context window", value: formatContextWindow(usage.window) },
      {
        label: "in context now",
        value:
          usage.tokens == null
            ? "unknown until the next response"
            : formatTokens(usage.tokens),
      },
      {
        label: "window used",
        value:
          usage.percent == null ? "—" : `${Math.round(usage.percent)}%`,
      },
      { label: "spent", value: formatCost(usage.cost) }
    )
  } else if (usage.kind === "reported-input") {
    stats.push(
      { label: "agent", value: profiles[usage.harness]?.label ?? usage.harness },
      { label: "model", value: usage.model ?? "not reported" },
      {
        label: "model window",
        value: usage.window > 0 ? formatContextWindow(usage.window) : "not reported",
      },
      {
        label: "last reported input",
        value:
          usage.lastInput == null ? "not reported" : formatTokens(usage.lastInput),
      },
      {
        label: "loaded history spend",
        value: usage.cost == null ? "not reported" : formatCost(usage.cost),
      }
    )
  } else {
    stats.push(
      { label: "agent", value: profiles[usage.harness]?.label ?? usage.harness },
      { label: "model", value: usage.model ?? "not reported" },
      {
        label: "context",
        value: "not reported by this live protocol",
      }
    )
  }

  const tokenStats = usage.kind === "unavailable" ? null : usage.stats
  if (tokenStats && tokenStats.total > 0) {
    stats.push(
      { label: "input tokens", value: formatTokens(tokenStats.input) },
      { label: "output tokens", value: formatTokens(tokenStats.output) },
      { label: "cache read", value: formatTokens(tokenStats.cacheRead) },
      { label: "cache written", value: formatTokens(tokenStats.cacheWrite) }
    )
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 @[20rem]:grid-cols-2">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0">
            <div className="text-label text-faint">{stat.label}</div>
            <div className="tabular truncate text-ui font-medium text-foreground/90">{stat.value}</div>
          </div>
        ))}
      </div>
      {tokenStats && tokenStats.total > 0 ? (
        <TokenMix
          stats={tokenStats}
          label={
            usage.owner === "thread"
              ? "token mix in loaded history"
              : "token mix this session"
          }
        />
      ) : null}
    </section>
  )
}

/**
 * Where the billed tokens went, as one stacked bar. A monochrome luminance
 * ramp rather than hues: the legend carries the names, the widths carry the
 * story, and this stays inside the "hue only where it means something" rule.
 */
const MIX = [
  { key: "input", label: "input", tone: "bg-foreground/75" },
  { key: "output", label: "output", tone: "bg-foreground/50" },
  { key: "cacheRead", label: "cache read", tone: "bg-foreground/30" },
  { key: "cacheWrite", label: "cache written", tone: "bg-foreground/15" },
] as const

function TokenMix({
  stats,
  label,
}: {
  stats: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  label: string
}) {
  const total = stats.input + stats.output + stats.cacheRead + stats.cacheWrite
  if (total <= 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="text-label text-faint">{label}</div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-raised">
        {MIX.map((segment) => (
          <span
            key={segment.key}
            className={cn("h-full", segment.tone)}
            style={{ width: `${(stats[segment.key] / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {MIX.map((segment) => (
          <span key={segment.key} className="flex items-center gap-1 text-label text-faint">
            <span className={cn("size-2 rounded-[3px]", segment.tone)} />
            {segment.label}
            <span className="tabular text-faint/70">{Math.round((stats[segment.key] / total) * 100)}%</span>
          </span>
        ))}
      </div>
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
  const nativeMessages = useSession((state) => state.messages)
  const changed = useSession((state) => state.git?.files)
  const viewing = useThreads((state) => state.viewing)
  const acpSession = useAcp((state) => activeLiveAcp(state)?.session ?? null)
  const acpBlocks = useAcp((state) => activeAcp(state)?.blocks ?? EMPTY_BLOCKS)
  const focus = useWorkspaceFocus()
  const messages = useMemo(() => {
    const history = viewing
      ? threadToMessages(
          viewing.entries,
          viewing.pageStart,
          viewing.ref.harness
        )
      : []
    const live = acpSession
      ? acpBlocksToMessages(
          acpBlocks,
          acpSession.status === "running",
          acpSession.harness
        ).messages
      : []
    return history.length > 0 || live.length > 0
      ? [...history, ...live]
      : nativeMessages
  }, [acpBlocks, acpSession, nativeMessages, viewing])
  const visibleChanges = focus.ready ? changed : undefined
  const files = useMemo(() => touchedFiles(messages), [messages])
  const stats = useMemo(() => {
    const map = new Map<string, { insertions: number; deletions: number }>()
    for (const file of visibleChanges ?? []) {
      map.set(file.path, { insertions: file.insertions, deletions: file.deletions })
    }
    return map
  }, [visibleChanges])

  if (!focus.ready || files.length === 0) return null

  return (
    <Section title="Files in play" count={files.length}>
      <ListCard className="px-1.5 py-1">
        {files.map((file) => (
          <FileRow key={file.path} file={file} stat={stats.get(file.path)} />
        ))}
      </ListCard>
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
      onClick={() => void viewer.open(file.path)}
      className="contain-turn flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover [contain-intrinsic-size:auto_30px]"
    >
      <Icon className={cn("size-3 shrink-0", FILE_TONE[file.action])} />
      <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
        {fileName(file.path)}
        <span className="ml-1.5 text-label text-faint">{fileDir(file.path)}</span>
      </span>
      {file.count > 1 ? (
        <span className="tabular shrink-0 text-label text-faint">{file.count}×</span>
      ) : null}
      {stat ? (
        <span className="tabular shrink-0 text-label">
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
      <ListCard className="px-1.5 py-1">
        {skills.map((skill) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            open={open === skill.name}
            onToggle={() => setOpen(open === skill.name ? undefined : skill.name)}
          />
        ))}
      </ListCard>
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
    <div className="group contain-turn [contain-intrinsic-size:auto_30px]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover"
      >
        <BookOpenIcon className="size-3 shrink-0 text-faint" />
        <span className="shrink-0 text-ui text-foreground/90">
          <span className="text-faint">$</span>
          {skill.name}
        </span>
        {/* The description trails the name on the same line and is cut by the
            card edge, so it hints at what this is without ever costing a
            second row. Opening one is a deliberate act. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-label text-faint",
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
          className="pressable shrink-0 rounded px-1 text-label text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-foreground"
        >
          use
        </span>
      </button>
      {open ? (
        <p className="animate-thread px-1.5 pt-0.5 pb-1.5 pl-[26px] text-label leading-relaxed text-muted-foreground">
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
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 pb-1 text-left"
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
        <ListCard className="px-1.5 py-1">
          {tools.map((tool) => (
            <button
              key={tool.name}
              type="button"
              role="switch"
              aria-checked={tool.active}
              onClick={() => toggle(tool.name, !tool.active)}
              title={tool.description}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover"
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
                  "min-w-0 flex-1 truncate text-ui",
                  tool.active ? "text-foreground/85" : "text-faint"
                )}
              >
                {tool.name}
              </span>
            </button>
          ))}
        </ListCard>
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
    <section>
      <div className="flex items-center gap-2 pb-1.5">
        <Eyebrow className="px-0">{title}</Eyebrow>
        <span className="tabular text-label text-faint">{count}</span>
      </div>
      {children}
    </section>
  )
}
