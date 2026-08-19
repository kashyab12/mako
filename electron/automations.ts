import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { JsonObject, JsonValue } from "./codex-app-protocol.js"
import type { Automation, AutomationRun, HostEvent } from "./shared.js"

/**
 * Saved prompts that can fire on their own.
 *
 * The triggers are chosen, not exhaustive, and the choices are worth stating:
 *
 *   * **Manual.** Always available. At minimum an automation is a prompt you
 *     do not have to retype, which is most of the value on its own.
 *   * **On file change**, matched by glob. This is the one people actually
 *     want — "when a migration lands, check the schema doc" — and it is the
 *     one that composes with an agent that edits files.
 *   * **On commit.** HEAD moving is the clearest "a unit of work finished"
 *     signal a repository has.
 *
 * Deliberately **not** on a schedule. A desktop app that is closed cannot fire
 * one, so a scheduled automation is a promise the app cannot keep; and an app
 * that is open quietly running cron jobs against your repository is a surprise
 * nobody asked for. If it ever needs a schedule it needs a daemon, and that is
 * a different product decision.
 *
 * Everything here is off until switched on, one at a time. A file that arrives
 * with a repository must not start running an agent because you opened the
 * folder.
 */

/** Where they live: in the project, so they can be committed and shared. */
const FILE = join(".mako", "automations.json")

/**
 * The floor between two runs of the same automation.
 *
 * A file-change trigger watching a directory an agent is actively editing can
 * fire dozens of times a minute. This is not a nicety — without it, one
 * automation can spend real money in a loop.
 */
const MIN_INTERVAL_MS = 60_000

/** Editors write a file several times per save; wait for it to settle. */
const DEBOUNCE_MS = 1200

interface Runtime {
  cwd: string
  watcher: FSWatcher | null
  timers: Map<string, NodeJS.Timeout>
  lastRun: Map<string, number>
  inFlight: Set<string>
  head: string | null
}

interface AutomationDocument {
  automations: Automation[]
}

let runtime: Runtime | null = null
let automations: Automation[] = []
let emit: (event: HostEvent) => void = () => {}
let launch:
  ((cwd: string, prompt: string, label: string) => Promise<void>) | null = null

export function automationList(): Automation[] {
  return automations
}

function publish() {
  emit({ type: "automations", automations })
}

export async function loadAutomations(cwd: string): Promise<Automation[]> {
  try {
    const document = parseAutomationDocument(
      await readFile(join(cwd, FILE), "utf8")
    )
    automations = document.automations
  } catch {
    automations = []
  }
  publish()
  return automations
}

function parseAutomationDocument(text: string): AutomationDocument {
  const value: JsonValue = JSON.parse(text)
  if (!isJsonObject(value) || !Array.isArray(value.automations))
    return { automations: [] }

  const entries: Automation[] = []
  for (const entry of value.automations) {
    if (!isJsonObject(entry)) throw new Error("Invalid automation")
    entries.push(normalize(entry))
  }
  return { automations: entries }
}

/**
 * A file from a repository is input, not configuration we wrote.
 *
 * `enabled` is forced off on load: an automation arrives from a checkout with
 * whatever the author set, and honouring that would mean cloning a repo could
 * start running an agent. Enabling is a local decision, held locally.
 */
function normalize(raw: JsonObject): Automation {
  return {
    id:
      String(raw.id ?? "").slice(0, 80) ||
      `a${Math.abs(hash(JSON.stringify(raw)))}`,
    name: String(raw.name ?? "Untitled").slice(0, 120),
    prompt: String(raw.prompt ?? "").slice(0, 8000),
    trigger:
      raw.trigger === "files" || raw.trigger === "commit"
        ? raw.trigger
        : "manual",
    paths: Array.isArray(raw.paths) ? raw.paths.slice(0, 40).map(String) : [],
    enabled: false,
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function hash(text: string): number {
  let value = 0
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0
  }
  return value
}

export async function saveAutomations(
  cwd: string,
  next: Automation[]
): Promise<Automation[]> {
  automations = next
  publish()
  try {
    await mkdir(join(cwd, ".mako"), { recursive: true })
    // `enabled` is not written: it is a local decision about a shared file, and
    // committing it would switch the automation on for everyone who clones.
    const shared = next.map((entry) => ({ ...entry, enabled: undefined }))
    await writeFile(
      join(cwd, FILE),
      `${JSON.stringify({ automations: shared }, null, 2)}\n`,
      "utf8"
    )
  } catch {
    // A project we cannot write to still gets working automations in memory.
  }
  return automations
}

/** Enabling is per-machine and is not written to the shared file. */
export function setEnabled(id: string, enabled: boolean): Automation[] {
  automations = automations.map((entry) =>
    entry.id === id ? { ...entry, enabled } : entry
  )
  publish()
  return automations
}

/* ------------------------------------------------------------------ */
/* matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Glob matching, small on purpose.
 *
 * `**` crosses directories, `*` does not, `?` is one character. That is the
 * whole vocabulary — enough for `src/**\/*.ts` and `migrations/*.sql`, which is
 * what these patterns are for, and small enough to read in one sitting rather
 * than pulling in a matcher.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  let source = ""
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] ?? ""
    if (char === "*" && pattern[index + 1] === "*") {
      // `**/` has to be able to match *no* directories, or `src/**/*.ts`
      // misses `src/session.ts` — which is the first thing anyone writes and
      // the first thing they would notice not working.
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?"
        index += 3
        continue
      }
      source += ".*"
      index += 2
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      index += 1
      continue
    }
    if (char === "?") {
      source += "[^/]"
      index += 1
      continue
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
    index += 1
  }
  try {
    return new RegExp(`^${source}$`).test(path)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* running                                                             */
/* ------------------------------------------------------------------ */

export function bindAutomations(
  send: (event: HostEvent) => void,
  run: (cwd: string, prompt: string, label: string) => Promise<void>
) {
  emit = send
  launch = run
}

/**
 * Fire one automation.
 *
 * Two guards, both about money rather than tidiness: an automation already
 * running does not start again, and one that ran a moment ago waits. A file
 * watcher pointed at a directory an agent is editing will otherwise re-trigger
 * on the agent's own output, which is a loop that bills.
 */
export async function fireAutomation(
  id: string,
  reason: AutomationRun["reason"]
): Promise<void> {
  const automation = automations.find((entry) => entry.id === id)
  const state = runtime
  if (!automation || !state || !launch) return
  if (state.inFlight.has(id)) return

  const last = state.lastRun.get(id) ?? 0
  if (reason !== "manual" && Date.now() - last < MIN_INTERVAL_MS) return

  state.inFlight.add(id)
  state.lastRun.set(id, Date.now())
  emit({
    type: "automation-run",
    run: { id, name: automation.name, reason, at: Date.now() },
  })
  try {
    await launch(state.cwd, automation.prompt, automation.name)
  } finally {
    state.inFlight.delete(id)
  }
}

/**
 * Watch the workspace.
 *
 * One recursive watcher for the whole tree rather than one per pattern: the
 * patterns are matched here, and a watcher per rule would multiply the same
 * events by the number of rules.
 */
export async function watchWorkspace(cwd: string) {
  stopWatching()
  runtime = {
    cwd,
    watcher: null,
    timers: new Map(),
    lastRun: new Map(),
    inFlight: new Set(),
    head: null,
  }
  await loadAutomations(cwd)

  try {
    runtime.watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (!filename || !runtime) return
      const path = relative(cwd, join(cwd, filename.toString()))
        .split(sep)
        .join("/")
      if (!path || isIgnored(path)) return

      for (const automation of automations) {
        if (!automation.enabled || automation.trigger !== "files") continue
        if (!automation.paths.some((pattern) => matchesGlob(pattern, path)))
          continue
        // Debounced per automation: a save that touches four matching files is
        // one event, not four.
        clearTimeout(runtime.timers.get(automation.id))
        runtime.timers.set(
          automation.id,
          setTimeout(
            () => void fireAutomation(automation.id, "files"),
            DEBOUNCE_MS
          )
        )
      }
    })
  } catch {
    // Recursive watching is unavailable on some platforms and some volumes.
    // File triggers simply do not fire there; manual ones still work.
  }
}

/** Directories whose churn is never what a rule means. */
const IGNORED =
  /(^|\/)(\.git|node_modules|dist|dist-electron|release|build|out|\.next|coverage|\.turbo)(\/|$)/

function isIgnored(path: string): boolean {
  return IGNORED.test(path)
}

/**
 * Notice a commit.
 *
 * Driven by the git status the app already computes rather than a watcher of
 * its own — the app re-reads git after every turn and on focus, which is
 * exactly when HEAD could have moved.
 */
export function noticeHead(head: string | undefined) {
  if (!runtime || !head) return
  const previous = runtime.head
  runtime.head = head
  if (previous === null || previous === head) return
  for (const automation of automations) {
    if (automation.enabled && automation.trigger === "commit") {
      void fireAutomation(automation.id, "commit")
    }
  }
}

export function stopWatching() {
  if (!runtime) return
  runtime.watcher?.close()
  for (const timer of runtime.timers.values()) clearTimeout(timer)
  runtime = null
}
