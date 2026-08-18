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
import type { HostEvent, ThreadRunState } from "./shared.js"

interface ResumeCommand {
  command: string
  args: string[]
}

/** How each harness resumes a session headlessly with one new message. */
const RESUME: Record<string, (nativeId: string, prompt: string) => ResumeCommand> = {
  codex: (id, prompt) => ({
    command: "codex",
    args: [
      "exec",
      "resume",
      id,
      prompt,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
    ],
  }),
  // No --fork-session: the default reuses the session id, so the turn lands
  // in the same file the viewer is tailing.
  claude: (id, prompt) => ({
    command: "claude",
    args: ["-p", prompt, "--resume", id, "--dangerously-skip-permissions"],
  }),
  cursor: (id, prompt) => ({
    command: "cursor-agent",
    args: ["-p", prompt, "--resume", id, "--force"],
  }),
  grok: (id, prompt) => ({
    command: "agent",
    args: ["-p", prompt, "--resume", id, "--always-approve"],
  }),
}

/**
 * How each harness starts a *new* headless session with an opening prompt.
 * Used by cross-harness continuation: the rendered handoff becomes the first
 * message of a fresh session in the same working directory, and the watcher
 * surfaces that session in the rail the moment its store appears.
 */
export interface FreshOptions {
  model?: string
  /** Reasoning effort, in the harness's own vocabulary. */
  effort?: string
  /** Cursor's fast mode; expressed as a bracket parameter on the model. */
  fast?: boolean
}

/**
 * Cursor takes tuning as bracket parameters on the model itself —
 * `sonnet-4.5[effort=high,fast=true]` — so its options fold into one flag.
 */
function cursorModel(options: FreshOptions): string | undefined {
  const params: string[] = []
  if (options.effort) params.push(`effort=${options.effort}`)
  if (options.fast !== undefined) params.push(`fast=${options.fast}`)
  if (!options.model && params.length === 0) return undefined
  const base = options.model ?? "auto"
  return params.length > 0 ? `${base}[${params.join(",")}]` : base
}

const FRESH: Record<string, (prompt: string, options: FreshOptions) => ResumeCommand> = {
  codex: (prompt, options) => ({
    command: "codex",
    args: [
      "exec",
      prompt,
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      ...(options.model ? ["-m", options.model] : []),
      ...(options.effort ? ["-c", `model_reasoning_effort="${options.effort}"`] : []),
    ],
  }),
  claude: (prompt, options) => ({
    command: "claude",
    args: [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      ...(options.model ? ["--model", options.model] : []),
      ...(options.effort ? ["--effort", options.effort] : []),
    ],
  }),
  cursor: (prompt, options) => {
    const model = cursorModel(options)
    return {
      command: "cursor-agent",
      args: ["-p", prompt, "--force", ...(model ? ["--model", model] : [])],
    }
  },
  grok: (prompt, options) => ({
    command: "agent",
    args: [
      "-p",
      prompt,
      "--always-approve",
      ...(options.model ? ["--model", options.model] : []),
      ...(options.effort ? ["--reasoning-effort", options.effort] : []),
    ],
  }),
}

/** What each harness's CLI actually accepts, for the composer to offer. */
export const HARNESS_TUNING: Record<
  string,
  { efforts: string[]; fast: boolean; curatedModels: string[] }
> = {
  claude: {
    // --effort low is the fast lever; max is the slow, thorough one.
    efforts: ["low", "medium", "high", "xhigh", "max"],
    fast: false,
    curatedModels: ["opus", "sonnet", "haiku"],
  },
  codex: {
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    fast: false,
    curatedModels: ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2"],
  },
  cursor: {
    efforts: ["low", "medium", "high"],
    fast: true,
    curatedModels: ["auto", "gpt-5.2", "sonnet-4.5-thinking", "opus-4.5"],
  },
  grok: {
    efforts: ["low", "medium", "high"],
    fast: false,
    curatedModels: ["grok-4.6", "grok-code"],
  },
}

export function resumableHarnesses(): string[] {
  return Object.keys(RESUME)
}

/** Which harness CLIs exist on this machine, by actually looking. */
export async function harnessAvailability(): Promise<Record<string, boolean>> {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(execFile)
  const commands: Record<string, string> = {
    codex: "codex",
    claude: "claude",
    cursor: "cursor-agent",
    grok: "agent",
  }
  const out: Record<string, boolean> = { pi: true }
  await Promise.all(
    Object.entries(commands).map(async ([harness, command]) => {
      try {
        await run("which", [command])
        out[harness] = true
      } catch {
        out[harness] = false
      }
    })
  )
  return out
}

export function freshHarnesses(): string[] {
  return Object.keys(FRESH)
}

interface Run {
  child: ChildProcess
  state: ThreadRunState
}

const runs = new Map<string, Run>()
let emit: (event: HostEvent) => void = () => {}

export function bindDrivers(send: (event: HostEvent) => void): void {
  emit = send
}

export function threadRun(path: string): ThreadRunState | null {
  return runs.get(path)?.state ?? null
}

/**
 * Send one message to the harness that owns this thread.
 *
 * One run per thread at a time — a session file being appended to by two
 * processes is corruption, not concurrency. The returned state is also
 * pushed as events as it changes.
 */
export async function resumeNative(ref: ThreadRef, prompt: string): Promise<ThreadRunState> {
  const existing = runs.get(ref.path)
  if (existing && existing.state.status === "running") return existing.state

  const make = RESUME[ref.harness]
  if (!make) throw new Error(`Sessions from ${ref.harness} cannot be resumed here`)
  return launch(ref.path, ref.harness, ref.cwd, make(ref.nativeId, prompt))
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
  const make = FRESH[harness]
  if (!make) throw new Error(`A new ${harness} session cannot be started from here`)
  return launch(`fresh:${harness}:${++freshCounter}`, harness, cwd, make(prompt, options))
}

async function launch(
  key: string,
  harness: string,
  workingDir: string | undefined,
  resume: ResumeCommand
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
  const run: Run = { child, state }
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
  child.stdout?.resume() // Drain; the transcript arrives via the file watcher.

  child.on("error", (error) => {
    finish(run, {
      status: "failed",
      error: error.message.includes("ENOENT") ? `${command} is not installed` : error.message,
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
  runs.set(run.state.path, run)
  push(run.state)
}

function push(state: ThreadRunState): void {
  emit({ type: "thread-run", run: state })
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n")
  return (lines[lines.length - 1] ?? "").slice(0, 300)
}
