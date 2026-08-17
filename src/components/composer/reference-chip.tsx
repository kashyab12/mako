import { fileKind } from "@/lib/mentions"
import { fileName } from "@/lib/format"
import { getPi } from "@/lib/bridge"
import { cn } from "@/lib/utils"
import type { ComponentType } from "react"
import {
  BookOpenIcon,
  BracesIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  PaletteIcon,
} from "lucide-react"

const KIND_ICON: Record<ReturnType<typeof fileKind>, ComponentType<{ className?: string }>> = {
  code: FileCodeIcon,
  style: PaletteIcon,
  config: BracesIcon,
  doc: FileTextIcon,
  image: ImageIcon,
  file: FileIcon,
}

/**
 * The inline form of a reference. The same chip renders in the composer and in
 * the transcript, which is what makes `@` feel like it produced an object
 * rather than decorated some text.
 */
export function FileChip({ path, interactive }: { path: string; interactive?: boolean }) {
  const Icon = KIND_ICON[fileKind(path)]
  const body = (
    <>
      <Icon className="size-3 shrink-0 text-faint" />
      <span className="truncate">{fileName(path)}</span>
    </>
  )
  const className = cn(
    "inline-flex max-w-[18rem] items-baseline gap-1 rounded bg-raised px-1 align-baseline",
    "font-mono text-[0.92em] leading-[1.35] text-foreground/85 ring-1 ring-hairline ring-inset",
    "[&_svg]:translate-y-[1.5px]"
  )

  if (!interactive) {
    return (
      <span className={className} title={path}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={`Open ${path}`}
      onClick={() => void getPi().revealPath(path)}
      className={cn(className, "pressable hover:bg-accent hover:text-foreground")}
    >
      {body}
    </button>
  )
}

export function SkillChip({ name }: { name: string }) {
  return (
    <span
      title={`Skill: ${name}`}
      className={cn(
        "inline-flex items-baseline gap-1 rounded bg-brand-soft px-1 align-baseline",
        "font-mono text-[0.92em] leading-[1.35] text-foreground ring-1 ring-border ring-inset",
        "[&_svg]:translate-y-[1.5px]"
      )}
    >
      <BookOpenIcon className="size-3 shrink-0 text-muted-foreground" />
      {name}
    </span>
  )
}
