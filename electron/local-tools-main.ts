import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { JsonValue } from "./codex-app-json.js"

const MAX_OUTPUT = 2 * 1024 * 1024
const DEFAULT_TIMEOUT = 20_000

export const LOCAL_TOOL_INPUTS = {
  apps: z.object({}).strict(),
  state: z.object({ app: z.string().min(1).max(256) }).strict(),
  see: z.object({ app: z.string().min(1).max(256) }).strict(),
  click: z
    .object({
      app: z.string().min(1).max(256),
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .strict(),
  key: z
    .object({
      app: z.string().min(1).max(256),
      keys: z.string().min(1).max(256),
    })
    .strict(),
  type: z
    .object({
      app: z.string().min(1).max(256),
      text: z.string().max(100_000),
    })
    .strict(),
  script: z
    .object({
      source: z.string().min(1).max(100_000),
      language: z.enum(["AppleScript", "JavaScript"]).default("AppleScript"),
    })
    .strict(),
  exec: z.object({ source: z.string().min(1).max(100_000) }).strict(),
} as const

type ProcessResult = { stdout: string; stderr: string; code: number | null }

async function executable(command: string): Promise<string | null> {
  const candidates = isAbsolute(command)
    ? [command]
    : [
        ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
        join(homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ].map((directory) => join(directory, command))
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

function runProcess(
  command: string,
  args: string[],
  stdin: string,
  signal: AbortSignal,
  timeout = DEFAULT_TIMEOUT
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) {
      reject(new Error("Tool call was cancelled"))
      return
    }
    const grouped = process.platform !== "win32"
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: grouped,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const terminate = () => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
          return
        } catch {
          // The process group already exited.
        }
      }
      child.kill("SIGKILL")
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      terminate()
      reject(error)
    }
    const onAbort = () => fail(new Error("Tool call was cancelled"))
    const timer = setTimeout(
      () => fail(new Error(`Tool timed out after ${timeout}ms`)),
      timeout
    )
    signal.addEventListener("abort", onAbort, { once: true })
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8")
      if (next.length <= MAX_OUTPUT) return next
      fail(new Error("Tool output exceeded the 2 MB limit"))
      return next.slice(0, MAX_OUTPUT)
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once("error", (error) => fail(error))
    child.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolveResult({ stdout, stderr, code })
    })
    child.stdin.end(stdin)
  })
}

function pythonProgram(expression: string, input: JsonValue): string {
  const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64")
  return [
    "import base64, json",
    `input = json.loads(base64.b64decode('${encoded}').decode('utf-8'))`,
    "def output(value):",
    "    print(json.dumps(value, default=str) if value is not None else json.dumps({'ok': True}))",
    `output(${expression})`,
    "",
  ].join("\n")
}

async function runHarnessProgram(
  source: string,
  signal: AbortSignal
): Promise<string> {
  const command = await executable("macos-harness")
  if (!command) throw new Error("macOS Harness is not installed")
  const result = await runProcess(command, [], source, signal)
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || `macOS Harness exited with code ${result.code}`
    )
  return result.stdout.trim() || "Completed"
}

async function runHarness(
  expression: string,
  input: JsonValue,
  signal: AbortSignal
): Promise<string> {
  return runHarnessProgram(pythonProgram(expression, input), signal)
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

async function safeResult(run: () => Promise<string>) {
  try {
    return textResult(await run())
  } catch (error) {
    return {
      ...textResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    }
  }
}

export function createLocalToolsServer(): McpServer {
  const server = new McpServer({ name: "mako-local-tools", version: "0.0.1" })
  server.registerTool(
    "mako_macos_apps",
    {
      description: "List running macOS applications visible to macOS Harness.",
      inputSchema: LOCAL_TOOL_INPUTS.apps,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_args, extra) =>
      safeResult(() => runHarness("mac.list_apps()", {}, extra.signal))
  )
  server.registerTool(
    "mako_macos_state",
    {
      description: "Read compact state for an already-running application.",
      inputSchema: LOCAL_TOOL_INPUTS.state,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ app }, extra) =>
      safeResult(() =>
        runHarness(
          "mac.get_app_state(input['app'], screenshot=False)",
          { app },
          extra.signal
        )
      )
  )
  server.registerTool(
    "mako_macos_see",
    {
      description:
        "Capture an already-running application without activating it.",
      inputSchema: LOCAL_TOOL_INPUTS.see,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ app }, extra) =>
      safeResult(() =>
        runHarness("mac.see(input['app'])", { app }, extra.signal)
      )
  )
  server.registerTool(
    "mako_macos_click",
    {
      description:
        "Send one coordinate click to an already-running application.",
      inputSchema: LOCAL_TOOL_INPUTS.click,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ app, x, y }, extra) =>
      safeResult(() =>
        runHarness(
          "mac.click(input['x'], input['y'], app=input['app'])",
          { app, x, y },
          extra.signal
        )
      )
  )
  server.registerTool(
    "mako_macos_key",
    {
      description:
        "Send a bounded key chord to an already-running application.",
      inputSchema: LOCAL_TOOL_INPUTS.key,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ app, keys }, extra) =>
      safeResult(() =>
        runHarness(
          "mac.key(input['keys'], app=input['app'])",
          { app, keys },
          extra.signal
        )
      )
  )
  server.registerTool(
    "mako_macos_type",
    {
      description: "Type text into an already-running application.",
      inputSchema: LOCAL_TOOL_INPUTS.type,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ app, text }, extra) =>
      safeResult(() =>
        runHarness(
          "mac.type(input['text'], app=input['app'])",
          { app, text },
          extra.signal
        )
      )
  )
  server.registerTool(
    "mako_macos_script",
    {
      description:
        "Run bounded AppleScript or JXA locally through macOS Harness.",
      inputSchema: LOCAL_TOOL_INPUTS.script,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ source, language }, extra) =>
      safeResult(() =>
        runHarness(
          "mac.script(input['source'], language=input['language'])",
          { source, language },
          extra.signal
        )
      )
  )
  server.registerTool(
    "mako_macos_exec",
    {
      description:
        "Run one bounded macOS Harness Python program for a desktop-app decision. The program may use preloaded mac, Path, and subprocess; prefer browser_exec for websites. Bundle reversible actions, then print one verification result.",
      inputSchema: LOCAL_TOOL_INPUTS.exec,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ source }, extra) =>
      safeResult(() => runHarnessProgram(source, extra.signal))
  )
  return server
}

export async function startLocalToolsServer(): Promise<void> {
  await createLocalToolsServer().connect(new StdioServerTransport())
}

function reportStartupFailure(error: Error): void {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  void startLocalToolsServer().catch(reportStartupFailure)
}
