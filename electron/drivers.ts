/**
 * Continue a thread with its own harness.
 *
 * The other half of continuation: "Continue here" hands a conversation to
 * this app's agent, and this hands the user's next message back to the CLI
 * that owns the session — Codex, Claude Code, Cursor, Grok — headlessly, in
 * the thread's working directory.
 *
 * There is deliberately no stream parsing here. Every one of these CLIs
 * writes its native session store as it works, the catalog is already
 * watching those stores, and the open viewer is already tailing the file —
 * so the transcript arrives through the same path it would if the user had
 * run the CLI in a terminal. The driver's whole job is to start the process,
 * say whether it is running, and carry the exit status. That is what keeps a
 * new harness's driver at five lines instead of five hundred.
 *
 * Every CLI runs with its own auto-approval flag. That is what continuing a
 * session non-interactively *is* — there is no one at the prompt to approve
 * tool calls — and it matches how these agents are run on this machine. The
 * arguments are one table below, on purpose: the security posture of this
 * file should be readable in ten seconds.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import type { ThreadRef } from "@mako/sessions"
import { accountEnv, switchSuggestion } from "./accounts.js"
import { devinExecutable, openCodeExecutable } from "./harnesses.js"
import type { HostEvent, ThreadRunState } from "./shared.js"

interface ResumeCommand {
  command: string
  args: string[]
}

/**
 * How each harness starts a *new* headless session with an opening prompt.
 * Used by cross-harness continuation: the rendered handoff becomes the first
 * message of a fresh session in the same working directory, and the watcher
 * surfaces that session in the rail the moment its store appears.
 */
export interface FreshOptions {
  captureOutput?: boolean
  model?: string
  effort?: string
  fast?: boolean
  options?: Record<string, string | boolean>
}

interface CommandTuning {
  model?: string
  effort?: string
  cliEffort?: string
  fast?: boolean
  serviceTier?: string
}

function stringOption(value: string | boolean | undefined): string | undefined {
  if (value === undefined || value === true || value === false) return undefined
  return value
}

function commandTuning(options: FreshOptions | undefined): CommandTuning {
  if (!options) return {}
  const tuning: CommandTuning = {}
  const optionEffort = stringOption(options.options?.effort)
  const serviceTier = stringOption(options.options?.serviceTier)
  if (options.model !== undefined) tuning.model = options.model
  if (options.effort !== undefined) tuning.effort = options.effort
  if (options.effort || optionEffort !== undefined) {
    tuning.cliEffort = options.effort ?? optionEffort
  }
  if (options.fast !== undefined) tuning.fast = options.fast
  if (serviceTier !== undefined) tuning.serviceTier = serviceTier
  return tuning
}

/**
 * Cursor takes tuning as bracket parameters on the model itself —
 * `sonnet-4.5[effort=high,fast=true]` — so its options fold into one flag.
 */
function cursorModel(options: CommandTuning): string | undefined {
  const params: string[] = []
  if (options.effort) params.push(`effort=${options.effort}`)
  if (options.fast !== undefined) params.push(`fast=${options.fast}`)
  if (!options.model && params.length === 0) return undefined
  const base = options.model ?? "auto"
  return params.length > 0 ? `${base}[${params.join(",")}]` : base
}

function buildCodexResume(
  id: string,
  prompt: string,
  options?: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: "codex",
    args: [
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      ...(tuning.model ? ["-m", tuning.model] : []),
      ...(tuning.cliEffort !== undefined
        ? ["-c", `model_reasoning_effort="${tuning.cliEffort}"`]
        : []),
      ...(tuning.serviceTier !== undefined
        ? ["-c", `service_tier="${tuning.serviceTier}"`]
        : []),
      "resume",
      id,
      prompt,
    ],
  }
}

function buildClaudeResume(
  id: string,
  prompt: string,
  options?: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: "claude",
    args: [
      "-p",
      prompt,
      "--resume",
      id,
      "--dangerously-skip-permissions",
      ...(tuning.model ? ["--model", tuning.model] : []),
      ...(tuning.effort ? ["--effort", tuning.effort] : []),
    ],
  }
}

function buildCursorResume(
  id: string,
  prompt: string,
  options?: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: "cursor-agent",
    args: [
      "-p",
      prompt,
      "--resume",
      id,
      "--force",
      // Only when a model was chosen: effort/fast are bracket parameters on
      // the model flag, and passing "auto[...]" would silently change the
      // session's model just to express an effort.
      ...(tuning.model ? ["--model", cursorModel(tuning) ?? tuning.model] : []),
    ],
  }
}

function buildGrokResume(
  id: string,
  prompt: string,
  options?: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: "agent",
    args: [
      "-p",
      prompt,
      "--resume",
      id,
      "--always-approve",
      ...(tuning.model ? ["--model", tuning.model] : []),
      ...(tuning.cliEffort !== undefined
        ? ["--reasoning-effort", tuning.cliEffort]
        : []),
    ],
  }
}

function buildCodexFresh(prompt: string, options: FreshOptions): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: "codex",
    args: [
      "exec",
      prompt,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      ...(tuning.model ? ["-m", tuning.model] : []),
      ...(tuning.cliEffort !== undefined
        ? ["-c", `model_reasoning_effort="${tuning.cliEffort}"`]
        : []),
      ...(tuning.serviceTier !== undefined
        ? ["-c", `service_tier="${tuning.serviceTier}"`]
        : []),
    ],
  }
}

function buildClaudeFresh(
  prompt: string,
  options: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: "claude",
    args: [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      ...(tuning.model ? ["--model", tuning.model] : []),
      ...(tuning.effort ? ["--effort", tuning.effort] : []),
    ],
  }
}

function buildCursorFresh(
  prompt: string,
  options: FreshOptions
): ResumeCommand {
  const model = cursorModel(commandTuning(options))
  return {
    command: "cursor-agent",
    args: ["-p", prompt, "--force", ...(model ? ["--model", model] : [])],
  }
}

function buildGrokFresh(prompt: string, options: FreshOptions): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: "agent",
    args: [
      "-p",
      prompt,
      "--always-approve",
      ...(tuning.model ? ["--model", tuning.model] : []),
      ...(tuning.cliEffort !== undefined
        ? ["--reasoning-effort", tuning.cliEffort]
        : []),
    ],
  }
}

function buildDevinResume(
  id: string,
  prompt: string,
  options?: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: devinExecutable() ?? "devin",
    args: [
      "-p",
      prompt,
      "--resume",
      id,
      "--permission-mode",
      "smart",
      "--respect-workspace-trust",
      "false",
      ...(tuning.model ? ["--model", tuning.model] : []),
    ],
  }
}

function buildDevinFresh(prompt: string, options: FreshOptions): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: devinExecutable() ?? "devin",
    args: [
      "-p",
      prompt,
      "--permission-mode",
      "smart",
      "--respect-workspace-trust",
      "false",
      ...(tuning.model ? ["--model", tuning.model] : []),
    ],
  }
}

function buildOpenCodeResume(
  id: string,
  prompt: string,
  options?: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: openCodeExecutable() ?? "opencode",
    args: [
      "run",
      "--session",
      id,
      ...(tuning.model ? ["--model", tuning.model] : []),
      ...(tuning.cliEffort ? ["--variant", tuning.cliEffort] : []),
      prompt,
    ],
  }
}

function buildOpenCodeFresh(
  prompt: string,
  options: FreshOptions
): ResumeCommand {
  const tuning = commandTuning(options)
  return {
    command: openCodeExecutable() ?? "opencode",
    args: [
      "run",
      ...(tuning.model ? ["--model", tuning.model] : []),
      ...(tuning.cliEffort ? ["--variant", tuning.cliEffort] : []),
      prompt,
    ],
  }
}

/** How each harness resumes a session headlessly with one new message. */
const RESUME = {
  codex: buildCodexResume,
  // No --fork-session: the default reuses the session id, so the turn lands
  // in the same file the viewer is tailing.
  claude: buildClaudeResume,
  cursor: buildCursorResume,
  grok: buildGrokResume,
  devin: buildDevinResume,
  opencode: buildOpenCodeResume,
}

const FRESH = {
  codex: buildCodexFresh,
  claude: buildClaudeFresh,
  cursor: buildCursorFresh,
  grok: buildGrokFresh,
  devin: buildDevinFresh,
  opencode: buildOpenCodeFresh,
}

export function resumableHarnesses(): string[] {
  return Object.keys(RESUME)
}

export function freshHarnesses(): string[] {
  return Object.keys(FRESH)
}

export interface NativeRunResult {
  state: ThreadRunState
  text: string
}

interface Run {
  child: ChildProcess
  completed?: Promise<NativeRunResult>
  resolve: (result: NativeRunResult) => void
  state: ThreadRunState
  stdout: string
}

const runs = new Map<string, Run>()
const MAX_REMEMBERED_RUNS = 600
let emit: (event: HostEvent) => void = () => {}

export function bindDrivers(send: (event: HostEvent) => void): void {
  emit = send
}

export function threadRun(path: string): ThreadRunState | null {
  return runs.get(path)?.state ?? null
}

export async function waitForNativeRun(
  path: string,
  timeoutMs = 30 * 60 * 1000
): Promise<NativeRunResult> {
  const run = runs.get(path)
  const completed = run?.completed
  if (!run || !completed) throw new Error(`No captured native run exists for ${path}`)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    run.child.kill("SIGTERM")
  }, timeoutMs)
  try {
    const result = await completed
    return timedOut
      ? {
          state: {
            ...result.state,
            status: "failed",
            error: "The local harness exceeded its 30 minute Slack limit",
          },
          text: result.text,
        }
      : result
  } finally {
    clearTimeout(timer)
    run.completed = undefined
    run.stdout = ""
  }
}

/**
 * Send one message to the harness that owns this thread.
 *
 * One run per thread at a time — a session file being appended to by two
 * processes is corruption, not concurrency. The returned state is also
 * pushed as events as it changes.
 */
export async function resumeNative(
  ref: ThreadRef,
  prompt: string,
  tuning?: FreshOptions
): Promise<ThreadRunState> {
  const existing = runs.get(ref.path)
  if (existing && existing.state.status === "running") return existing.state

  const make = Object.entries(RESUME).find(
    ([harness]) => harness === ref.harness
  )?.[1]
  if (!make)
    throw new Error(`Sessions from ${ref.harness} cannot be resumed here`)
  return launch(
    ref.path,
    ref.harness,
    ref.cwd,
    make(ref.nativeId, prompt, tuning),
    tuning?.captureOutput ?? false
  )
}

/**
 * Start a fresh headless session on another harness, opened with a handoff.
 *
 * The run is keyed by a synthetic path — there is no session file until the
 * CLI creates one — and the session itself arrives in the catalog through
 * the watcher, like any other session anything starts on this machine.
 */
let freshCounter = 0

export async function startFresh(
  harness: string,
  cwd: string | undefined,
  prompt: string,
  options: FreshOptions = {}
): Promise<ThreadRunState> {
  const make = Object.entries(FRESH).find(
    ([candidate]) => candidate === harness
  )?.[1]
  if (!make)
    throw new Error(`A new ${harness} session cannot be started from here`)
  return launch(
    `fresh:${harness}:${++freshCounter}`,
    harness,
    cwd,
    make(prompt, options),
    options.captureOutput ?? false
  )
}

async function launch(
  key: string,
  harness: string,
  workingDir: string | undefined,
  resume: ResumeCommand,
  captureOutput: boolean
): Promise<ThreadRunState> {
  const { command, args } = resume
  const cwd = workingDir && existsSync(workingDir) ? workingDir : homedir()
  // The selected account decides who pays for this run.
  const env = await accountEnv(harness, process.env)
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  })

  const state: ThreadRunState = { path: key, harness, status: "running" }
  let resolveRun: (result: NativeRunResult) => void = () => {}
  const completed = captureOutput
    ? new Promise<NativeRunResult>((resolve) => {
        resolveRun = resolve
      })
    : undefined
  const run: Run = {
    child,
    completed,
    resolve: resolveRun,
    state,
    stdout: "",
  }
  runs.set(key, run)
  push(state)

  // The moment someone spends from an account is the moment its headroom is
  // worth a look. Suggest, never switch: money moves are the user's.
  if (harness === "claude" || harness === "codex") {
    void switchSuggestion(harness)
      .then((message) => {
        if (message) emit({ type: "notice", level: "info", message })
      })
      .catch(() => {})
  }

  // Keep the tail of stderr: when a CLI fails it says why there, and "exit
  // code 1" with no words is the worst message this feature could show.
  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000)
  })
  if (captureOutput) {
    child.stdout?.on("data", (chunk: Buffer) => {
      run.stdout = (run.stdout + chunk.toString()).slice(-1024 * 1024)
    })
  } else {
    child.stdout?.resume()
  }

  child.on("error", (error) => {
    finish(run, {
      status: "failed",
      error: error.message.includes("ENOENT")
        ? `${command} is not installed`
        : error.message,
    })
  })
  child.on("exit", (code, signal) => {
    if (run.state.status !== "running") return
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      finish(run, { status: "stopped" })
    } else if (code === 0) {
      finish(run, { status: "done" })
    } else {
      finish(run, {
        status: "failed",
        error: lastLine(stderr) || `${command} exited with code ${code}`,
      })
    }
  })

  return state
}

export function abortNative(path: string): void {
  const run = runs.get(path)
  if (run && run.state.status === "running") run.child.kill("SIGTERM")
}

export function stopDrivers(): void {
  for (const run of runs.values()) {
    if (run.state.status === "running") run.child.kill("SIGTERM")
  }
}

function finish(run: Run, next: Partial<ThreadRunState>): void {
  run.state = { ...run.state, ...next }
  runs.delete(run.state.path)
  runs.set(run.state.path, run)
  while (runs.size > MAX_REMEMBERED_RUNS) {
    let removed = false
    for (const [path, entry] of runs) {
      if (entry.state.status === "running") continue
      runs.delete(path)
      removed = true
      break
    }
    if (!removed) break
  }
  push(run.state)
  run.resolve({ state: run.state, text: run.stdout.trim() })
}

function push(state: ThreadRunState): void {
  emit({ type: "thread-run", run: state })
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n")
  return (lines[lines.length - 1] ?? "").slice(0, 300)
}
