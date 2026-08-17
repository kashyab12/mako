const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const dayYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

export function formatTime(value?: string | number) {
  const date = toDate(value)
  return date ? time.format(date) : ""
}

export function formatDay(value?: string | number) {
  const date = toDate(value)
  if (!date) return ""
  return date.getFullYear() === new Date().getFullYear() ? day.format(date) : dayYear.format(date)
}

/** "now", "12m", "3h", "Mon", "Apr 3" — the rail needs width discipline. */
export function formatRelative(value?: string | number) {
  const date = toDate(value)
  if (!date) return ""
  const seconds = (Date.now() - date.getTime()) / 1000
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`
  return formatDay(date.getTime())
}

/** Day buckets for the session rail. */
export function bucketFor(value?: string | number) {
  const date = toDate(value)
  if (!date) return "Earlier"
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const days = Math.floor((start.getTime() - date.getTime()) / 86_400_000)
  if (days < 0) return "Today"
  if (days === 0) return "Yesterday"
  if (days < 7) return "This week"
  if (days < 30) return "This month"
  return "Earlier"
}

function toDate(value?: string | number) {
  if (value == null || value === "") return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatTokens(count: number) {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

export function formatCost(value: number) {
  if (!value) return "$0.00"
  if (value < 0.01) return "<$0.01"
  return `$${value.toFixed(value < 10 ? 2 : 1)}`
}

/** Model pricing arrives per-token; humans read per-million. */
export function formatRate(perToken: number) {
  if (!perToken) return "—"
  const perMillion = perToken * 1_000_000
  return perMillion >= 10 ? `$${perMillion.toFixed(0)}` : `$${perMillion.toFixed(2)}`
}

export function formatContextWindow(tokens: number) {
  if (!tokens) return "—"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  return `${Math.round(tokens / 1000)}K`
}

export function workspaceName(cwd?: string) {
  if (!cwd) return "Workspace"
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd
}

export function fileName(path: string) {
  return path.split("/").at(-1) ?? path
}

export function fileDir(path: string) {
  const parts = path.split("/")
  parts.pop()
  return parts.join("/")
}

export function textOf(blocks: Array<{ type: string; text?: string; thinking?: string }>) {
  let out = ""
  for (const block of blocks) {
    if (block.type === "text" && block.text) out += block.text
    else if (block.type === "thinking" && block.thinking) out += block.thinking
  }
  return out.trim()
}

export function firstLine(value: string, limit = 120) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}
