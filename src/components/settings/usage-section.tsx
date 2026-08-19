import { useEffect, useState } from "react"
import { Eyebrow } from "@/components/ui/kit"
import { getMako, hasBridge } from "@/lib/bridge"
import { formatTokens } from "@/lib/format"
import type { UsageSummary } from "@/lib/types"

/**
 * Where the money went.
 *
 * Read from the session files on disk, which already record what every priced
 * message cost. That is deliberately not "billing": billing needs a payment
 * method and an account, which is a server and a product decision. This
 * answers the question people actually ask, and answers it exactly.
 */
export function UsageSection() {
  const [data, setData] = useState<UsageSummary>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!hasBridge()) return
    void getMako()
      .usage()
      .then(setData)
      .catch(() => setData(undefined))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="shimmer text-ui">Reading sessions…</p>
  if (!data || data.total.messages === 0) {
    return (
      <p className="rounded-lg bg-surface px-3 py-4 text-center text-ui text-faint ring-1 ring-hairline">
        Nothing priced yet. Spend appears here as soon as a model bills for a
        turn.
      </p>
    )
  }

  const peak = Math.max(...data.days.map((day) => day.cost), 0.0001)

  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-lg bg-surface px-3 py-3 ring-1 ring-hairline">
        <div className="flex items-baseline gap-2">
          <span className="tabular text-title font-medium">
            {money(data.total.cost)}
          </span>
          <span className="text-ui text-faint">
            across {data.sessions}{" "}
            {data.sessions === 1 ? "session" : "sessions"} ·{" "}
            {formatTokens(data.total.input + data.total.output)} tokens
          </span>
        </div>

        {data.days.length > 1 ? (
          <>
            {/* Bars, not a chart library. Thirty numbers with a shared maximum
                is a shape you can read at a glance, and it costs nothing. */}
            <div className="mt-3 flex h-12 items-end gap-[2px]">
              {data.days.map((day) => (
                <div
                  key={day.date}
                  title={`${day.date} · ${money(day.cost)}`}
                  className="min-w-[3px] flex-1 rounded-sm bg-foreground/25 transition-colors duration-100 hover:bg-foreground/50"
                  style={{ height: `${Math.max(2, (day.cost / peak) * 100)}%` }}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-label text-faint">
              <span>{data.days[0]?.date}</span>
              <span>{data.days.at(-1)?.date}</span>
            </div>
          </>
        ) : null}
      </div>

      {/* Models and projects that cost nothing are not an answer to "where did
          the money go" — they are rows to scroll past. */}
      <Breakdown
        title="By model"
        rows={data.models
          .filter((m) => m.cost > 0)
          .map((m) => ({ label: m.model, cost: m.cost }))}
        total={data.total.cost}
      />
      <Breakdown
        title="By project"
        rows={data.projects
          .filter((p) => p.cost > 0)
          .map((p) => ({ label: shortPath(p.cwd), cost: p.cost }))}
        total={data.total.cost}
      />

      <p className="mt-3 text-ui leading-relaxed text-faint">
        Read from your session files, on this machine. This is spend, not
        billing — a payment method and an account are a server and a decision,
        not something to imply with a currency symbol.
        {data.truncated
          ? " Older sessions were left unread to keep the scan quick."
          : ""}
      </p>
    </div>
  )
}

function Breakdown({
  title,
  rows,
  total,
}: {
  title: string
  rows: Array<{ label: string; cost: number }>
  total: number
}) {
  if (rows.length === 0) return null
  return (
    <div className="mt-3">
      <Eyebrow className="px-0 pb-1">{title}</Eyebrow>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-2 rounded-md px-1.5 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
              {row.label}
            </span>
            <span
              aria-hidden
              className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-raised"
            >
              <span
                className="block h-full rounded-full bg-foreground/35"
                style={{
                  width: `${total > 0 ? Math.round((row.cost / total) * 100) : 0}%`,
                }}
              />
            </span>
            <span className="tabular w-14 shrink-0 text-right text-ui">
              {money(row.cost)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Sub-cent amounts still deserve a real number rather than "$0.00". */
function money(value: number): string {
  if (value === 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~")
}
