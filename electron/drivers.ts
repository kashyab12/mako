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

export function resumableHarnesses(): string[] {
  return Object.keys(RESUME)
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
export function resumeNative(ref: ThreadRef, prompt: string): ThreadRunState {
  const existing = runs.get(ref.path)
  if (existing && existing.state.status === "running") return existing.state

  const make = RESUME[ref.harness]
  if (!make) throw new Error(`Sessions from ${ref.harness} cannot be resumed here`)
  const { command, args } = make(ref.nativeId, prompt)

  const cwd = ref.cwd && existsSync(ref.cwd) ? ref.cwd : homedir()
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })

  const state: ThreadRunState = { path: ref.path, harness: ref.harness, status: "running" }
  const run: Run = { child, state }
  runs.set(ref.path, run)
  push(state)

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
