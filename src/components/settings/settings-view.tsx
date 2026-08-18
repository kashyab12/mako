import { useCallback, useEffect, useState } from "react"
import { Action, Eyebrow, Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { getPi, hasBridge } from "@/lib/bridge"
import { setPref, togglePref, usePrefs, type Theme } from "@/state/prefs"
import { cn } from "@/lib/utils"
import { formatRelative } from "@/lib/format"
import { updates, useUpdates } from "@/state/updates"
import { automations, useAutomations } from "@/state/automations"
import type { CrashReport } from "../../../electron/crash.ts"
import { RotateCcwIcon, XIcon } from "lucide-react"

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "transcript", label: "Transcript" },
  { id: "commits", label: "Commit messages" },
  { id: "automations", label: "Automations" },
  { id: "updates", label: "Updates" },
  { id: "diagnostics", label: "Diagnostics" },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

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
export function SettingsView() {
  const [section, setSection] = useState<SectionId>("appearance")
  const [defaultPrompt, setDefaultPrompt] = useState("")
  const open = true

  useEffect(() => {
    if (defaultPrompt || !hasBridge()) return
    void getPi()
      .defaultCommitPrompt()
      .then(setDefaultPrompt)
      .catch(() => setDefaultPrompt(""))
  }, [defaultPrompt])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.dispatchEvent(new CustomEvent("pi:close-settings"))
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
                ? "bg-raised font-medium text-foreground"
                : "text-muted-foreground hover:bg-raised/60 hover:text-foreground"
            )}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("pi:close-settings"))}
          className="pressable mt-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-faint hover:bg-raised hover:text-foreground"
        >
          <XIcon className="size-3.5" />
          Close settings
        </button>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-[42rem] px-6 py-6">
          {section === "appearance" ? <Appearance /> : null}
          {section === "transcript" ? <Transcript /> : null}
          {section === "commits" ? <CommitPrompt fallback={defaultPrompt} /> : null}
          {section === "automations" ? <Automations /> : null}
          {section === "updates" ? <Updates /> : null}
          {section === "diagnostics" ? <Diagnostics /> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Saved prompts, and what makes them run.
 *
 * Every one arrives switched off. The definitions come from a file in the
 * project — committable, shareable — but whether one is allowed to run an
 * agent on this machine is a decision made here, and cloning a repository must
 * never make it for you.
 */
function Automations() {
  const list = useAutomations((state) => state.list)
  const recent = useAutomations((state) => state.recent)

  useEffect(() => {
    void automations.load()
  }, [])

  return (
    <Section title="Automations">
      <p className="pb-2 text-[12px] leading-relaxed text-muted-foreground">
        Prompts that can run on their own, defined in <code className="text-faint">.mako/automations.json</code>.
        Each one starts switched off — a file from a checkout does not get to run an agent because
        you opened the folder. A run opens a tab in the background; it never takes the window.
      </p>

      {list.length === 0 ? (
        <p className="rounded-lg bg-surface px-3 py-4 text-center text-[12px] text-faint ring-1 ring-hairline">
          This project has none. Add <code>.mako/automations.json</code> with a name, a prompt, and a
          trigger of <code>manual</code>, <code>files</code>, or <code>commit</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {list.map((entry) => (
            <div key={entry.id} className="rounded-lg bg-surface px-3 py-2.5 ring-1 ring-hairline">
              <div className="flex items-center gap-2">
                <Toggle on={entry.enabled} onChange={() => void automations.setEnabled(entry.id, !entry.enabled)} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{entry.name}</span>
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
            last run: {recent[0]?.name} · {formatRelative(new Date(recent[0]?.at ?? 0).toISOString())}
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
        There is no schedule trigger. An app that is closed cannot fire one, and an app that is open
        quietly running jobs against your repository is a surprise nobody asked for. A file trigger
        waits a minute between runs, so an agent editing the files it watches cannot loop.
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
          <span className="text-[12.5px] font-medium">Mako {version || "—"}</span>
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
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-raised/60 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {notes}
          </pre>
        ) : null}

        <div className="mt-3 flex items-center gap-2">
          {status === "ready" ? (
            <Action tone="brand" onClick={() => updates.install()}>
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
          Updates download on their own but never install on their own. A turn can run for minutes
          and touch real files; restarting underneath one is not an improvement.
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
    void getPi().crashes().then(setCrashes).catch(() => setCrashes([]))
    void getPi().crashesDir().then(setDir).catch(() => setDir(""))
  }, [])

  useEffect(load, [load])

  return (
    <Section title="Crash reports">
      <p className="pb-2 text-[12px] leading-relaxed text-muted-foreground">
        Written to this machine and nowhere else. Nothing here is sent anywhere — copy a report if
        you want to pass it on.
      </p>

      {crashes.length === 0 ? (
        <p className="rounded-lg bg-surface px-3 py-4 text-center text-[12px] text-faint ring-1 ring-hairline">
          Nothing has crashed. This stays empty unless something does.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {crashes.map((crash) => (
            <div key={crash.id} className="rounded-lg bg-surface ring-1 ring-hairline">
              <button
                type="button"
                onClick={() => setOpenId(openId === crash.id ? undefined : crash.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10px] text-faint">
                  {crash.kind.replace("-", " ")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]">{crash.message}</span>
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
                      onClick={() => void navigator.clipboard.writeText(JSON.stringify(crash, null, 2))}
                    >
                      Copy the report
                    </Action>
                    <span className="text-[10.5px] text-faint">
                      {crash.app.version} · Electron {crash.app.electron} · {crash.os.platform}{" "}
                      {crash.os.arch}
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
          <Action tone="ghost" onClick={() => void getPi().revealPath(dir)}>
            Show the folder
          </Action>
        ) : null}
        {crashes.length > 0 ? (
          <Action
            tone="danger"
            onClick={() => {
              void getPi().clearCrashes().then(load)
            }}
          >
            Delete them all
          </Action>
        ) : null}
      </div>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <Eyebrow className="px-0 pb-2">{title}</Eyebrow>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

function Appearance() {
  const theme = usePrefs((prefs) => prefs.theme)
  const glass = usePrefs((prefs) => prefs.glass)

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
      <Row label="Depth" hint="Translucent panels and a soft light wash">
        <Toggle on={glass} onChange={() => togglePref("glass")} />
      </Row>
    </Section>
  )
}

function Transcript() {
  const showThinking = usePrefs((prefs) => prefs.showThinking)
  const autoDiff = usePrefs((prefs) => prefs.autoOpenDiff)

  return (
    <Section title="Transcript and changes">
      <Row label="Show reasoning" hint="Collapsed by default; this hides it entirely">
        <Toggle on={showThinking} onChange={() => togglePref("showThinking")} />
      </Row>
      <Row label="Open the diff on select" hint="Off keeps the changes panel as a plain list">
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
        The instructions used when drafting a commit message from the diff. The default is the
        prompt Zed ships, which is well tuned; edit it to change the house style.
      </p>

      <textarea
        value={value}
        spellCheck={false}
        rows={18}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null) setPref("commitPrompt", draft.trim() ? draft : undefined)
          setDraft(null)
        }}
        className={cn(
          "w-full resize-y rounded-lg bg-raised/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed",
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
    <div className="flex h-6 shrink-0 items-center rounded-md bg-raised/70 p-[2px]">
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

