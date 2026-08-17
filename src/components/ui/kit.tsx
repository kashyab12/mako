import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ComponentProps, ReactNode } from "react"

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

const base =
  "pressable no-drag inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-md " +
  "text-[12.5px] font-medium whitespace-nowrap " +
  "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease,color_120ms_ease,opacity_120ms_ease] " +
  "disabled:pointer-events-none disabled:opacity-40 " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0"

const tones = {
  ghost:
    "text-muted-foreground hover:not-disabled:bg-raised hover:not-disabled:text-foreground data-[on=true]:bg-raised data-[on=true]:text-foreground",
  quiet: "text-foreground/80 hover:not-disabled:bg-raised hover:not-disabled:text-foreground",
  solid: "bg-primary text-primary-foreground hover:not-disabled:opacity-90",
  brand: "bg-brand text-background hover:not-disabled:opacity-90",
  outline: "border border-border text-foreground hover:not-disabled:bg-raised",
  danger: "text-negative hover:not-disabled:bg-negative/12",
} as const

const sizes = {
  xs: "h-6 px-1.5 [&_svg]:size-3.5",
  sm: "h-7 px-2 [&_svg]:size-3.5",
  md: "h-8 px-2.5 [&_svg]:size-4",
} as const

export function Action({
  className,
  tone = "ghost",
  size = "sm",
  ...props
}: ComponentProps<"button"> & { tone?: keyof typeof tones; size?: keyof typeof sizes }) {
  return <button type="button" className={cn(base, tones[tone], sizes[size], className)} {...props} />
}

export function IconAction({
  className,
  tone = "ghost",
  size = "sm",
  label,
  keys,
  side = "bottom",
  ...props
}: ComponentProps<"button"> & {
  tone?: keyof typeof tones
  size?: keyof typeof sizes
  label: string
  keys?: string[]
  side?: "top" | "bottom" | "left" | "right"
}) {
  const square = size === "xs" ? "size-6" : size === "sm" ? "size-7" : "size-8"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(base, tones[tone], sizes[size], "px-0", square, className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side={side} className="gap-2">
        {label}
        {keys?.length ? <Keys keys={keys} inverted /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

/* ------------------------------------------------------------------ */
/* Text bits                                                           */
/* ------------------------------------------------------------------ */

export function Keys({ keys, inverted }: { keys: string[]; inverted?: boolean }) {
  if (!keys.length) return null
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          data-slot="kbd"
          className={cn(
            "inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] px-1 font-sans text-[10px] leading-none",
            inverted
              ? "bg-background/15 text-background"
              : "bg-raised text-faint ring-1 ring-hairline ring-inset"
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}

export function Chip({
  className,
  tone = "neutral",
  children,
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "brand" | "positive" | "negative" | "caution" }) {
  const palette = {
    neutral: "bg-raised text-muted-foreground ring-hairline",
    brand: "bg-brand-soft text-brand ring-brand/25",
    positive: "bg-positive/12 text-positive ring-positive/25",
    negative: "bg-negative/12 text-negative ring-negative/25",
    caution: "bg-caution/12 text-caution ring-caution/25",
  }[tone]
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-[10.5px] font-medium ring-1 ring-inset",
        palette,
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

/**
 * A section label. Sentence case and unremarkable on purpose — uppercase
 * micro-labels with letterspacing are the single most recognisable tell of a
 * generated interface, and they cost legibility at this size for nothing.
 */
export function Eyebrow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("px-1 text-[11px] font-medium text-faint", className)} {...props} />
  )
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

export function PanelHeader({
  title,
  meta,
  actions,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-2.5",
        className
      )}
    >
      <span className="truncate text-[11.5px] font-semibold text-foreground">{title}</span>
      {meta ? <span className="truncate text-[11px] text-faint">{meta}</span> : null}
      <div className="ml-auto flex items-center gap-0.5">{actions}</div>
    </header>
  )
}

export function Blank({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      {icon ? (
        <div className="mb-1 flex size-8 items-center justify-center rounded-lg bg-raised text-faint [&_svg]:size-4">
          {icon}
        </div>
      ) : null}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {body ? <p className="max-w-[26ch] text-[12px] leading-relaxed text-faint">{body}</p> : null}
      {action}
    </div>
  )
}

/** Horizontal usage bar — context window, diff ratio, anything 0..1. */
export function Meter({
  value,
  tone = "brand",
  className,
}: {
  value: number
  tone?: "brand" | "caution" | "negative" | "positive"
  className?: string
}) {
  const color = {
    brand: "bg-brand",
    caution: "bg-caution",
    negative: "bg-negative",
    positive: "bg-positive",
  }[tone]
  return (
    <span className={cn("block h-[3px] w-full overflow-hidden rounded-full bg-raised", className)}>
      <span
        className={cn("block h-full rounded-full transition-[width] duration-500", color)}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  )
}
