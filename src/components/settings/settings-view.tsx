import { useCallback, useEffect, useState } from "react"
import { Action, Eyebrow, Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { getMako, hasBridge } from "@/lib/bridge"
import { setPref, togglePref, usePrefs, type Theme } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { formatRelative, formatTokens } from "@/lib/format"
import { updates, useUpdates } from "@/state/updates"
import { automations, useAutomations } from "@/state/automations"
import type { CrashReport } from "../../../electron/crash.ts"
import type { UsageSummary } from "@/lib/types"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { PluginsSection } from "@/components/settings/plugins-section"
import { McpSection } from "@/components/settings/mcp-section"
import { KeyboardSection } from "@/components/settings/keyboard-section"
import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

const SECTIONS = [
  { id: "agents", label: "Providers & accounts" },
  { id: "commits", label: "Git & pull requests" },
  { id: "mcp", label: "External tools" },
  { id: "appearance", label: "Appearance" },
  { id: "keyboard", label: "Keyboard shortcuts" },
  { id: "transcript", label: "Conversation" },
  { id: "usage", label: "Usage & limits" },
  { id: "automations", label: "Automations" },
  { id: "plugins", label: "Plugins" },
  { id: "updates", label: "Updates" },
  { id: "diagnostics", label: "Troubleshoot" },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

function isSectionId(value: string): value is SectionId {
  return SECTIONS.some((section) => section.id === value)
}

/**
 * Settings.
 *
 * A view rather than a modal. Settings here are things you read and compare —
 * a multi-paragraph commit prompt most of all — and a dialog floating over a
 * dimmed transcript is the wrong shape for that: it is cramped, it hides the
 * thing being configured, and it implies you are meant to leave quickly. Both
 * T3 and ORCA route settings to full surfaces with a section list for exactly
 * this reason.
 */
export function SettingsView({ initialSection = "agents" }: { initialSection?: string }) {
  const [section, setSection] = useState<SectionId>(
    isSectionId(initialSection) ? initialSection : "agents"
  )
  const [defaultPrompt, setDefaultPrompt] = useState("")
  const open = true

  useEffect(() => {
    if (defaultPrompt || !hasBridge()) return
    void getMako()
      .defaultCommitPrompt()
      .then(setDefaultPrompt)
      .catch(() => setDefaultPrompt(""))
  }, [defaultPrompt])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape")
        window.dispatchEvent(new CustomEvent("mako:close-settings"))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!open) return null

  return (
    <div className="flex min-h-0 flex-1">
      {/* A section list, so the surface scales past three groups without
          turning into one long scroll. */}
      <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-hairline p-2">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setSection(entry.id)}
            className={cn(
              "rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors duration-100",
              section === entry.id
                ? "bg-fill-selected font-medium text-foreground"
                : "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
            )}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("mako:close-settings"))
          }
          className="pressable mt-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <XIcon className="size-3.5" />
          Close settings
        </button>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-content px-6 py-6">
          {section === "appearance" ? <Appearance /> : null}
          {section === "keyboard" ? <KeyboardSection /> : null}
          {section === "transcript" ? <Transcript /> : null}
          {section === "commits" ? (
            <CommitPrompt fallback={defaultPrompt} />
          ) : null}
          {section === "usage" ? <Usage /> : null}
          {section === "agents" ? <Agents /> : null}
          {section === "mcp" ? <McpSection /> : null}
          {section === "plugins" ? <PluginsSection /> : null}
          {section === "automations" ? <Automations /> : null}
          {section === "updates" ? <Updates /> : null}
          {section === "diagnostics" ? <Diagnostics /> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Where the money went.
 *
 * Read from the session files on disk, which already record what every priced
 * message cost. That is deliberately not "billing": billing needs a payment
 * method and an account, which is a server and a product decision. This
 * answers the question people actually ask, and answers it exactly.
 */
function Usage() {
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

  if (loading)
    return (
      <Section title="Usage">
        <p className="shimmer text-[12px]">Reading sessions…</p>
      </Section>
    )
  if (!data || data.total.messages === 0) {
    return (
      <Section title="Usage">
        <p className="rounded-lg bg-surface px-3 py-4 text-center text-[12px] text-faint ring-1 ring-hairline">
          Nothing priced yet. Spend appears here as soon as a model bills for a
          turn.
        </p>
      </Section>
    )
  }

  const peak = Math.max(...data.days.map((day) => day.cost), 0.0001)

  return (
    <Section title="Usage">
      <div className="rounded-lg bg-surface px-3 py-3 ring-1 ring-hairline">
        <div className="flex items-baseline gap-2">
          <span className="tabular text-[18px] font-medium">
            {money(data.total.cost)}
          </span>
          <span className="text-[11.5px] text-faint">
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
            <div className="mt-1 flex justify-between text-[10px] text-faint">
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

      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
        Read from your session files, on this machine. This is spend, not
        billing — a payment method and an account are a server and a decision,
        not something to imply with a currency symbol.
        {data.truncated
          ? " Older sessions were left unread to keep the scan quick."
          : ""}
      </p>
    </Section>
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
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/85">
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
            <span className="tabular w-14 shrink-0 text-right text-[11.5px]">
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

/**
 * Saved prompts, and what makes them run.
 *
 * Every one arrives switched off. The definitions come from a file in the
 * project — committable, shareable — but whether one is allowed to run an
 * agent on this machine is a decision made here, and cloning a repository must
 * never make it for you.
 */
/**
 * The harnesses this machine can host, and the accounts that need keys.
 *
 * Provider rows report the native control transport Mako found on this
 * machine. Claude and Codex can route through several isolated account homes;
 * Devin can additionally connect cloud sessions through service keys kept in
 * ~/.mako/devin.json and never displayed beyond the last four characters.
 */
function Agents() {
  const conversionMode = usePrefs((prefs) => prefs.conversionMode)
  const [availability, setAvailability] = useState<Record<
    string,
    boolean
  > | null>(null)
  const [daemon, setDaemon] = useState<{
    pid: number
    startedAt: number
    sessions: number
  } | null>(null)
  const [loginStart, setLoginStart] = useState<boolean | null>(null)

  const load = useCallback(() => {
    if (!hasBridge()) return
    void getMako()
      .harnessAvailability()
      .then(setAvailability)
      .catch(() => setAvailability({}))
    void getMako()
      .daemonStatus()
      .then(setDaemon)
      .catch(() => setDaemon(null))
    void getMako()
      .daemonLogin()
      .then(setLoginStart)
      .catch(() => setLoginStart(null))
  }, [])
  useEffect(load, [load])

  const HARNESSES = [
    { id: "claude", name: "Claude Code", how: "claude CLI" },
    { id: "codex", name: "Codex", how: "codex CLI" },
    { id: "cursor", name: "Cursor", how: "cursor-agent CLI" },
    { id: "grok", name: "Grok", how: "grok CLI" },
    { id: "devin", name: "Devin", how: "devin CLI / Zed / IDE" },
  ]

  return (
    <Section title="Agents">
      <Row
        label="Moving conversations"
        hint="Transcript replay gives the next agent a deterministic newest-first bundle with reasoning, tool calls, and complete captured outputs. Session import writes a lossy copy into the target store."
      >
        <Segmented<"native" | "transcript">
          value={conversionMode}
          options={[
            { value: "transcript", label: "Transcript replay" },
            { value: "native", label: "Session import" },
          ]}
          onChange={(next) => setPref("conversionMode", next)}
        />
      </Row>
      <p className="pb-3 text-[12px] leading-relaxed text-muted-foreground">
        Mako uses the provider apps already installed on this machine. Their
        model and reasoning settings are copied once as a sensible starting
        point; after that, choices made in Mako stay in Mako.
      </p>
      <p className="mb-3 flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1.5 text-[11px] text-faint">
        <span
          className={cn(
            "size-1.5 rounded-full",
            daemon ? "bg-added" : "bg-faint/50"
          )}
        />
        <span className="min-w-0 flex-1">
          {daemon
            ? `Sync daemon running — ${daemon.sessions} sessions watched, up since ${formatRelative(new Date(daemon.startedAt).toISOString())}, syncing even with the app closed`
            : "Sync daemon not running — the app is watching sessions itself while open"}
        </span>
        {loginStart !== null ? (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={loginStart}
              onChange={(event) => {
                const next = event.target.checked
                setLoginStart(next)
                void getMako()
                  .setDaemonLogin(next)
                  .catch(() => setLoginStart(!next))
              }}
              className="size-3 accent-current"
            />
            start at login
          </label>
        ) : null}
      </p>
      <div className="flex flex-col">
        {HARNESSES.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center gap-2.5 border-b border-hairline py-2 last:border-b-0"
          >
            <HarnessIcon harness={entry.id} className="size-4" />
            <span className="min-w-0 flex-1 text-[12.5px]">{entry.name}</span>
            <span className="text-[11px] text-faint">{entry.how}</span>
            {availability === null ? (
              <span className="w-14 shimmer text-right text-[11px] text-faint">
                …
              </span>
            ) : availability[entry.id] ? (
              <span className="text-[11px] text-added">Ready</span>
            ) : (
              <span className="text-[11px] text-faint">Not installed</span>
            )}
          </div>
        ))}
      </div>

      <HarnessAccounts />
    </Section>
  )
}

/**
 * Several logins per CLI, switchable — the Orca mechanism: each captured
 * account is an isolated config home selected by env var at spawn, with
 * everything except credentials symlinked back to the real home, so skills
 * and sessions stay identical across accounts. Usage windows come from the
 * providers' own endpoints; a bar near full is the reason to switch.
 */
function HarnessAccounts() {
  const [accounts, setAccounts] = useState<
    Array<{
      harness: "claude" | "codex"
      name: string
      email?: string
      active: boolean
      source?: "mako" | "subrouter"
    }>
  >([])
  const [usage, setUsage] = useState<
    Record<
      string,
      {
        status: string
        plan?: string
        detail?: string
        session?: { usedPercent: number; resetsAt: number | null } | null
        weekly?: { usedPercent: number; resetsAt: number | null } | null
      }
    >
  >({})
  const [capturing, setCapturing] = useState<"claude" | "codex" | null>(null)
  const [captureName, setCaptureName] = useState("")
  const [busyAccount, setBusyAccount] = useState<string>()

  const load = useCallback(function loadAccounts() {
    if (!hasBridge()) return
    void getMako()
      .accounts()
      .then((list) => {
        setAccounts(list)
        for (const account of list) {
          void getMako()
            .accountUsage(account.harness, account.name)
            .then((value) =>
              setUsage((prev) => ({
                ...prev,
                [`${account.harness}:${account.name}`]: value,
              }))
            )
            .catch(() => {})
        }
      })
      .catch((error) => {
        setAccounts([])
        toast.error("Accounts could not be loaded", {
          description: error instanceof Error ? error.message : String(error),
          action: { label: "Retry", onClick: loadAccounts },
        })
      })
  }, [])
  useEffect(load, [load])

  const capture = async () => {
    if (!capturing || !captureName.trim()) return
    try {
      await getMako().captureAccount(capturing, captureName.trim())
      setCapturing(null)
      setCaptureName("")
      load()
    } catch (error) {
      toast.error("Account was not captured", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Try again", onClick: () => void capture() },
      })
    }
  }

  const select = async (harness: "claude" | "codex", name: string) => {
    const key = `${harness}:${name}`
    if (busyAccount) return
    setBusyAccount(key)
    try {
      await getMako().selectAccount(harness, name === "default" ? null : name)
      load()
    } catch (error) {
      toast.error("Account was not switched", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void select(harness, name) },
      })
    } finally {
      setBusyAccount(undefined)
    }
  }

  const remove = async (harness: "claude" | "codex", name: string) => {
    const key = `${harness}:${name}`
    if (busyAccount) return
    setBusyAccount(key)
    try {
      await getMako().removeAccount(harness, name)
      load()
    } catch (error) {
      toast.error("Account was not removed", {
        description: error instanceof Error ? error.message : String(error),
        action: { label: "Retry", onClick: () => void remove(harness, name) },
      })
    } finally {
      setBusyAccount(undefined)
    }
  }

  return (
    <>
      {(["claude", "codex"] as const).map((harness) => {
        const rows = accounts.filter((account) => account.harness === harness)
        if (rows.length === 0) return null
        return (
          <div key={harness}>
            <Eyebrow className="pt-6 pb-2">
              {harness === "claude" ? "Claude Code accounts" : "Codex accounts"}
            </Eyebrow>
            <p className="pb-2 text-[11.5px] leading-relaxed text-faint">
              Mako keeps each login isolated while sharing the same sessions,
              skills, and tools. The active account is used for new sessions.
            </p>
            {rows.map((account) => {
              const stats = usage[`${harness}:${account.name}`]
              const identity = account.email ?? account.name
              const key = `${harness}:${account.name}`
              return (
                <div
                  key={account.name}
                  className={cn(
                    "group/account flex w-full items-center rounded-lg transition-colors duration-100",
                    account.active
                      ? "bg-raised ring-1 ring-hairline"
                      : "hover:bg-fill-hover"
                  )}
                >
                  <button
                    type="button"
                    disabled={Boolean(busyAccount)}
                    onClick={() => void select(harness, account.name)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2 text-left disabled:opacity-60"
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                        account.active
                          ? "bg-fill-selected text-foreground"
                          : "bg-raised text-faint"
                      )}
                    >
                      {identity.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-none basis-56">
                      <span
                        className={cn(
                          "block truncate text-[12.5px]",
                          account.active
                            ? "font-medium text-foreground"
                            : "text-foreground/85"
                        )}
                      >
                        {identity}
                      </span>
                      <span className="block text-[10px] text-faint">
                        {account.active
                          ? "Used for new sessions in Mako"
                          : account.source === "subrouter"
                            ? "Available from Subrouter"
                            : account.name === "default"
                              ? "The CLI's current login"
                              : `Captured as ${account.name}`}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      {stats?.status === "ok" ? (
                        <span className="flex items-center gap-2">
                          <UsageBar label="5h" window={stats.session} />
                          <UsageBar label="week" window={stats.weekly} />
                          {stats.plan ? (
                            <span className="text-[10px] text-faint">
                              {stats.plan}
                            </span>
                          ) : null}
                        </span>
                      ) : stats ? (
                        <span className="text-[10.5px] text-faint">
                          {stats.status === "stale-token"
                            ? (stats.detail ?? "Sign in again to refresh usage")
                            : stats.status === "missing-credentials"
                              ? "Sign in with the CLI to use this account"
                              : (stats.detail ?? "Usage is temporarily unavailable")}
                        </span>
                      ) : (
                        <span className="shimmer text-[10.5px] text-faint">
                          Loading usage…
                        </span>
                      )}
                    </span>
                    {account.active ? (
                      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-foreground">
                        <CheckIcon className="size-3.5" />
                        Active
                      </span>
                    ) : busyAccount === key ? (
                      <span className="shimmer shrink-0 text-[10.5px] text-faint">
                        Switching…
                      </span>
                    ) : null}
                  </button>
                  {account.name !== "default" && account.source !== "subrouter" ? (
                    <button
                      type="button"
                      aria-label={`Remove ${account.name}`}
                      disabled={Boolean(busyAccount)}
                      onClick={() => void remove(harness, account.name)}
                      className="pressable mr-1.5 rounded p-1 text-faint opacity-0 transition-opacity duration-100 group-hover/account:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              )
            })}
            {capturing === harness ? (
              <div className="mt-2 rounded-lg bg-surface p-2.5 ring-1 ring-hairline">
                <p className="pb-2 text-[11.5px] text-muted-foreground">
                  First run <code className="font-mono text-foreground">{harness === "claude" ? "claude /login" : "codex login"}</code> in a terminal. Then name that login in Mako.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={captureName}
                    onChange={(event) => setCaptureName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void capture()
                    }}
                    placeholder="Name, such as Work"
                    className="h-7 w-44 rounded-md bg-raised px-2 text-[12px] text-foreground placeholder:text-faint focus:ring-1 focus:ring-hairline focus:outline-none"
                  />
                  <Action
                    disabled={!captureName.trim()}
                    onClick={() => void capture()}
                  >
                    Save current login
                  </Action>
                  <Action tone="ghost" onClick={() => setCapturing(null)}>Cancel</Action>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCapturing(harness)}
                className="pressable mt-2 rounded px-1 py-0.5 text-[11.5px] text-faint hover:bg-fill-hover hover:text-foreground"
              >
                Add another account
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

/** One window as a small bar: full is the signal, exact digits on hover. */
function UsageBar({
  label,
  window: win,
}: {
  label: string
  window?: { usedPercent: number; resetsAt: number | null } | null
}) {
  if (!win) return null
  const used = Math.max(0, Math.min(100, win.usedPercent))
  return (
    <span
      className="flex items-center gap-1"
      title={`${used}% used${win.resetsAt ? ` · resets ${formatRelative(new Date(win.resetsAt).toISOString())}` : ""}`}
    >
      <span className="text-[10px] text-faint">{label}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised">
        <span
          className={cn(
            "block h-full rounded-full",
            used >= 90
              ? "bg-removed"
              : used >= 70
                ? "bg-caution"
                : "bg-added"
          )}
          style={{ width: `${used}%` }}
        />
      </span>
      <span className="tabular text-[10px] text-faint">
        {Math.round(used)}%
      </span>
    </span>
  )
}

function Automations() {
  const list = useAutomations((state) => state.list)
  const recent = useAutomations((state) => state.recent)

  useEffect(() => {
    void automations.load()
  }, [])

  return (
    <Section title="Automations">
      <p className="pb-2 text-[12px] leading-relaxed text-muted-foreground">
        Prompts that can run on their own, defined in{" "}
        <code className="text-faint">.mako/automations.json</code>. Each one
        starts switched off — a file from a checkout does not get to run an
        agent because you opened the folder. A run opens a tab in the
        background; it never takes the window.
      </p>

      {list.length === 0 ? (
        <p className="rounded-lg bg-surface px-3 py-4 text-center text-[12px] text-faint ring-1 ring-hairline">
          This project has none. Add <code>.mako/automations.json</code> with a
          name, a prompt, and a trigger of <code>manual</code>,{" "}
          <code>files</code>, or <code>commit</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {list.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg bg-surface px-3 py-2.5 ring-1 ring-hairline"
            >
              <div className="flex items-center gap-2">
                <Toggle
                  on={entry.enabled}
                  onChange={() =>
                    void automations.setEnabled(entry.id, !entry.enabled)
                  }
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                  {entry.name}
                </span>
                <Action tone="ghost" onClick={() => automations.run(entry.id)}>
                  Run now
                </Action>
              </div>
              <p className="mt-1.5 line-clamp-2 pl-[42px] text-[11.5px] leading-relaxed text-muted-foreground">
                {entry.prompt}
              </p>
              <p className="mt-1 pl-[42px] text-[10.5px] text-faint">
                {entry.trigger === "files"
                  ? `when ${entry.paths.join(", ") || "nothing"} changes`
                  : entry.trigger === "commit"
                    ? "when you commit"
                    : "only when you ask"}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Action tone="outline" onClick={() => void automations.reload()}>
          Reload from disk
        </Action>
        {recent.length > 0 ? (
          <span className="text-[10.5px] text-faint">
            last run: {recent[0]?.name} ·{" "}
            {formatRelative(new Date(recent[0]?.at ?? 0).toISOString())}
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
        There is no schedule trigger. An app that is closed cannot fire one, and
        an app that is open quietly running jobs against your repository is a
        surprise nobody asked for. A file trigger waits a minute between runs,
        so an agent editing the files it watches cannot loop.
      </p>
    </Section>
  )
}

/** Which version is running, and whether there is a newer one. */
function Updates() {
  const status = useUpdates((state) => state.status)
  const version = useUpdates((state) => state.version)
  const available = useUpdates((state) => state.available)
  const progress = useUpdates((state) => state.progress)
  const notes = useUpdates((state) => state.notes)
  const error = useUpdates((state) => state.error)

  return (
    <Section title="Updates">
      <div className="rounded-lg bg-surface px-3 py-3 ring-1 ring-hairline">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] font-medium">
            Mako {version || "—"}
          </span>
          <span className="text-[11.5px] text-faint">
            {status === "unsupported"
              ? "running from a checkout, so there is nothing to update"
              : status === "checking"
                ? "checking…"
                : status === "downloading"
                  ? `downloading ${available ?? ""} · ${progress ?? 0}%`
                  : status === "ready"
                    ? `${available} is ready to install`
                    : status === "error"
                      ? (error ?? "could not reach the update feed")
                      : "up to date"}
          </span>
        </div>

        {notes ? (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-raised p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {notes}
          </pre>
        ) : null}

        <div className="mt-3 flex items-center gap-2">
          {status === "ready" ? (
            <Action tone="solid" onClick={() => updates.install()}>
              Restart and install
            </Action>
          ) : null}
          <Action
            tone="outline"
            disabled={status === "checking" || status === "unsupported"}
            onClick={() => void updates.check()}
          >
            Check now
          </Action>
        </div>

        <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
          Updates download on their own but never install on their own. A turn
          can run for minutes and touch real files; restarting underneath one is
          not an improvement.
        </p>
      </div>
    </Section>
  )
}

/**
 * What broke, and where it is written down.
 *
 * Crash reports are useless if nobody can find them, and a report you cannot
 * read is a report you cannot decide to send. This lists them, shows the stack,
 * and gives one button to copy the whole thing — which is what someone
 * actually needs when they want to tell you what happened.
 */
function Diagnostics() {
  const [crashes, setCrashes] = useState<CrashReport[]>([])
  const [dir, setDir] = useState("")
  const [openId, setOpenId] = useState<string>()

  const load = useCallback(() => {
    if (!hasBridge()) return
    void getMako()
      .crashes()
      .then(setCrashes)
      .catch(() => setCrashes([]))
    void getMako()
      .crashesDir()
      .then(setDir)
      .catch(() => setDir(""))
  }, [])

  useEffect(load, [load])

  return (
    <Section title="Crash reports">
      <p className="pb-2 text-[12px] leading-relaxed text-muted-foreground">
        Written to this machine and nowhere else. Nothing here is sent anywhere
        — copy a report if you want to pass it on.
      </p>

      {crashes.length === 0 ? (
        <p className="rounded-lg bg-surface px-3 py-4 text-center text-[12px] text-faint ring-1 ring-hairline">
          Nothing has crashed. This stays empty unless something does.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {crashes.map((crash) => (
            <div
              key={crash.id}
              className="rounded-lg bg-surface ring-1 ring-hairline"
            >
              <button
                type="button"
                onClick={() =>
                  setOpenId(openId === crash.id ? undefined : crash.id)
                }
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10px] text-faint">
                  {crash.kind.replace("-", " ")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]">
                  {crash.message}
                </span>
                <span className="tabular shrink-0 text-[10.5px] text-faint">
                  {formatRelative(crash.at)}
                </span>
              </button>
              {openId === crash.id ? (
                <div className="border-t border-hairline px-3 py-2">
                  <pre className="max-h-56 overflow-auto font-mono text-[10.5px] leading-relaxed text-faint">
                    {crash.stack ?? "No stack was captured."}
                  </pre>
                  <div className="mt-2 flex items-center gap-2">
                    <Action
                      tone="outline"
                      onClick={() =>
                        void navigator.clipboard.writeText(
                          JSON.stringify(crash, null, 2)
                        )
                      }
                    >
                      Copy the report
                    </Action>
                    <span className="text-[10.5px] text-faint">
                      {crash.app.version} · Electron {crash.app.electron} ·{" "}
                      {crash.os.platform} {crash.os.arch}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Action tone="outline" onClick={load}>
          Refresh
        </Action>
        {dir ? (
          <Action tone="ghost" onClick={() => void getMako().revealPath(dir)}>
            Show the folder
          </Action>
        ) : null}
        {crashes.length > 0 ? (
          <Action
            tone="danger"
            onClick={() => {
              void getMako().clearCrashes().then(load)
            }}
          >
            Delete them all
          </Action>
        ) : null}
      </div>
    </Section>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-5 last:mb-0">
      <Eyebrow className="px-0 pb-2">{title}</Eyebrow>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

function Appearance() {
  const theme = usePrefs((prefs) => prefs.theme)

  return (
    <Section title="Appearance">
      <Row label="Theme" hint="Follows the system when set to Auto">
        <Segmented<Theme>
          value={theme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "Auto" },
          ]}
          onChange={(next) => setPref("theme", next)}
        />
      </Row>
    </Section>
  )
}

function Transcript() {
  const showThinking = usePrefs((prefs) => prefs.showThinking)
  const autoDiff = usePrefs((prefs) => prefs.autoOpenDiff)

  return (
    <Section title="Transcript and changes">
      <Row
        label="Show reasoning"
        hint="Collapsed by default; this hides it entirely"
      >
        <Toggle on={showThinking} onChange={() => togglePref("showThinking")} />
      </Row>
      <Row
        label="Open the diff on select"
        hint="Off keeps the changes panel as a plain list"
      >
        <Toggle on={autoDiff} onChange={() => togglePref("autoOpenDiff")} />
      </Row>
    </Section>
  )
}

function CommitPrompt({ fallback }: { fallback: string }) {
  const stored = usePrefs((prefs) => prefs.commitPrompt)
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? stored ?? fallback
  const customized = Boolean(stored && stored !== fallback)

  return (
    <Section title="Commit messages">
      <p className="px-0.5 pb-1.5 text-[11px] leading-relaxed text-faint">
        The instructions used when drafting a commit message from the diff. The
        default is the prompt Zed ships, which is well tuned; edit it to change
        the house style.
      </p>

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
          "w-full resize-y rounded-lg bg-raised px-2.5 py-2 font-mono text-[11.5px] leading-relaxed",
          "ring-1 ring-hairline focus:outline-none focus-visible:ring-border"
        )}
      />

      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10.5px] text-faint">
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
        <span className="flex items-center gap-1 text-[10.5px] text-faint">
          <Keys keys={formatChord("mod+shift+g")} /> drafts
        </span>
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ */

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg px-0.5 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]">{label}</span>
        <span className="block text-[10.5px] text-faint">{hint}</span>
      </span>
      {children}
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className={cn(
        "pressable flex h-4 w-7 shrink-0 items-center rounded-full p-[2px]",
        "[transition:background-color_150ms_ease]",
        on ? "bg-foreground/80" : "bg-foreground/15"
      )}
    >
      <span
        className={cn(
          "block size-3 rounded-full bg-background",
          "[transition:transform_180ms_var(--ease-out)]",
          on ? "translate-x-3" : "translate-x-0"
        )}
      />
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
}) {
  return (
    <div className="flex h-6 shrink-0 items-center rounded-md bg-raised p-[2px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-[4px] px-2 text-[10.5px] font-medium",
            "[transition:background-color_120ms_ease,color_120ms_ease]",
            value === option.value
              ? "bg-surface text-foreground"
              : "text-faint hover:text-muted-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
