import { useEffect, useMemo, useRef, useState } from "react"
import { Eyebrow, Keys } from "@/components/ui/kit"
import { fileKind, threadToken } from "@/lib/mentions"
import { fileDir, fileName, workspaceName } from "@/lib/format"
import { fuzzy } from "@/lib/fuzzy"
import { useSession } from "@/state/session"
import { useThreads } from "@/state/threads"
import { useWorkspaceFiles } from "@/state/files"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import { BookOpenIcon, FileIcon } from "lucide-react"

const LIMIT = 9

export type MentionKind = "@" | "$" | "/"

export interface MentionItem {
  value: string
  title: string
  hint?: string
  badge?: string
  type: "file" | "thread" | "skill" | "command"
  harness?: string
}

/**
 * One menu for all three composer sigils: `@` context, `$` skills, `/`
 * commands. They share ranking, keyboard handling, and geometry because from
 * the user's side they are the same gesture with a different vocabulary.
 */
export function MentionMenu({
  kind,
  query,
  onPick,
  onDismiss,
}: {
  kind: MentionKind
  query: string
  onPick: (value: string) => void
  onDismiss: () => void
}) {
  const skills = useSession((state) => state.capabilities.skills)
  const commands = useSession((state) => state.capabilities.commands)
  const threads = useThreads((state) => state.threads)
  const files = useWorkspaceFiles(kind === "@")
  const referenceItems = useMemo(
    () => [
      ...threads.map((thread) => ({
        value: threadToken(thread.harness, thread.nativeId),
        title: thread.title ?? "Untitled conversation",
        hint: [thread.harness, thread.cwd ? workspaceName(thread.cwd) : null]
          .filter(Boolean)
          .join(" · "),
        type: "thread" as const,
        harness: thread.harness,
        key: `${thread.title ?? ""} ${thread.cwd ?? ""} ${thread.harness} ${thread.model ?? ""}`,
      })),
      ...files.map((file) => ({
        value: `@${file.path}`,
        title: fileName(file.path),
        hint: fileDir(file.path),
        badge: file.changed ? "changed" : undefined,
        type: "file" as const,
        key: file.path,
      })),
    ],
    [files, threads]
  )

  const items = useMemo<MentionItem[]>(() => {
    if (kind === "@") return rank(referenceItems, query)
    if (kind === "$") {
      return rank(
        skills.map((skill) => ({
          value: `$${skill.name}`,
          title: skill.name,
          hint: skill.description,
          type: "skill" as const,
          key: `${skill.name} ${skill.description}`,
        })),
        query
      )
    }
    return rank(
      commands.map((command) => ({
        value: `/${command.name}`,
        title: `/${command.name}`,
        hint: command.description,
        type: "command" as const,
        key: `${command.name} ${command.description ?? ""}`,
      })),
      query
    )
  }, [commands, kind, query, referenceItems, skills])

  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setCursor(0)
  }

  // Capture-phase so the menu wins these keys before the textarea sees them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (items.length === 0) return
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        event.stopPropagation()
        setCursor((value) => {
          const next =
            (value + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length
          listRef.current
            ?.querySelector(`[data-index="${next}"]`)
            ?.scrollIntoView({ block: "nearest" })
          return next
        })
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        event.stopPropagation()
        const item = items[cursor]
        if (item) onPick(item.value)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onDismiss()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [cursor, items, onDismiss, onPick])

  if (items.length === 0) return null

  const label =
    kind === "@"
      ? "Conversations and files"
      : kind === "$"
        ? "Skills"
        : "Commands"
  const Icon = kind === "$" ? BookOpenIcon : FileIcon

  return (
    <div className="animate-enter absolute bottom-full left-0 z-20 mb-1.5 w-full overflow-hidden rounded-lg bg-popover p-1 ring-1 ring-border">
      <Eyebrow className="px-1.5 pt-1 pb-1">{label}</Eyebrow>
      <div
        ref={listRef}
        className="max-h-[15rem] overflow-y-auto overscroll-contain"
      >
        {items.map((item, index) => (
          <button
            key={item.value}
            type="button"
            data-index={index}
            onMouseMove={() => setCursor(index)}
            onClick={() => onPick(item.value)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left",
              index === cursor && "bg-fill-selected"
            )}
          >
            {item.type === "command" ? null : item.type === "thread" ? (
              <HarnessIcon
                harness={item.harness ?? ""}
                className="size-3 shrink-0"
              />
            ) : (
              <Icon
                className={cn(
                  "size-3 shrink-0 text-faint",
                  item.type === "file" &&
                    fileKind(item.value.slice(1)) === "code" &&
                    "text-muted-foreground"
                )}
              />
            )}
            <span className="max-w-[55%] min-w-0 shrink-0 truncate font-mono text-ui text-foreground/90">
              {item.title}
            </span>
            {item.hint ? (
              <span className="min-w-0 flex-1 truncate text-label text-faint">
                {item.hint}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {item.badge ? (
              <span className="shrink-0 rounded bg-caution/12 px-1 text-label text-caution">
                {item.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1 border-t border-hairline px-2 pt-1.5 pb-0.5 text-label text-faint">
        <Keys keys={["↑", "↓"]} /> move
        <Keys keys={["↩"]} /> insert
        <Keys keys={["Esc"]} /> dismiss
      </div>
    </div>
  )
}

function rank<T extends MentionItem & { key: string }>(
  items: T[],
  query: string
): MentionItem[] {
  const term = query.trim()
  if (!term) return items.slice(0, LIMIT)
  const top: Array<{ item: T; score: number }> = []
  for (const item of items) {
    const match = fuzzy(term, item.key)
    if (!match) continue
    const at = top.findIndex((entry) => match.score > entry.score)
    if (at === -1) top.push({ item, score: match.score })
    else top.splice(at, 0, { item, score: match.score })
    if (top.length > LIMIT) top.pop()
  }
  return top.map((entry) => entry.item)
}
