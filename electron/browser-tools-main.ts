import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  environmentForExecutable,
  resolveExecutable,
} from "./executable.js"

const MAX_OUTPUT = 2 * 1024 * 1024
const TIMEOUT = 60_000
const REMOTE_BROWSER =
  /(?:start|stop)_remote_daemon|browser[._-]?use[._-]?(?:api[._-]?key|cloud)|\b(?:BU_NAME|BH_REMOTE)\b|cloud\.browser-use\.com/i

export const BROWSER_TOOL_INPUTS = {
  doctor: z.object({}).strict(),
  exec: z
    .object({ source: z.string().min(1).max(100_000) })
    .strict()
    .refine(({ source }) => !REMOTE_BROWSER.test(source), {
      message: "Mako Browser Use is local-only",
    }),
} as const

function browserEnvironment(executable: string): NodeJS.ProcessEnv {
  const env = environmentForExecutable(executable, process.env)
  for (const name of Object.keys(env)) {
    if (
      /^(?:BU_NAME|BROWSER_USE_API_KEY|BROWSER_USE_CLOUD|BH_REMOTE)/i.test(
        name
      )
    )
      delete env[name]
  }
  return env
}

function runBrowserUseOnce(
  args: string[],
  source: string,
  signal: AbortSignal
): Promise<string> {
  const executable = resolveExecutable("browser-use")
  if (!executable) return Promise.reject(new Error("Browser Use is not installed"))
  return new Promise((resolveResult, reject) => {
    if (signal.aborted) {
      reject(new Error("Tool call was cancelled"))
      return
    }
    const child = spawn(executable, args, {
      env: browserEnvironment(executable),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const terminate = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
          return
        } catch {
          child.kill("SIGKILL")
          return
        }
      }
      child.kill("SIGKILL")
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      if (error) {
        terminate()
        reject(error)
      }
    }
    const append = (held: string, chunk: Buffer) => {
      const next = held + chunk.toString("utf8")
      if (next.length > MAX_OUTPUT) {
        finish(new Error("Browser output exceeded the 2 MB limit"))
        return next.slice(0, MAX_OUTPUT)
      }
      return next
    }
    const onAbort = () => finish(new Error("Tool call was cancelled"))
    const timer = setTimeout(
      () => finish(new Error(`Browser tool timed out after ${TIMEOUT}ms`)),
      TIMEOUT
    )
    signal.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once("error", (error) => finish(error))
    child.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      const output = `${stdout}\n${stderr}`
        .split("\n")
        .filter((line) => !/cloud auth|cloud browser/i.test(line))
        .join("\n")
        .trim()
      if (code === 0) resolveResult(output || "Completed")
      else reject(new Error(output || `Browser Use exited with ${code}`))
    })
    child.stdin.end(source)
  })
}

async function runBrowserUse(
  args: string[],
  source: string,
  signal: AbortSignal
): Promise<string> {
  try {
    return await runBrowserUseOnce(args, source, signal)
  } catch (error) {
    if (
      args.length > 0 ||
      !(error instanceof Error) ||
      !/(?:timed out|connection refused|daemon)/i.test(error.message)
    )
      throw error
    await runBrowserUseOnce(["--reload"], "", signal)
    return runBrowserUseOnce(args, source, signal)
  }
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

export function createBrowserToolsServer(): McpServer {
  const server = new McpServer({ name: "mako-browser-use", version: "0.0.1" })
  server.registerTool(
    "mako_browser_doctor",
    {
      description:
        "Diagnose Mako's local Browser Use connection to Chrome. Local only; no hosted or cloud browsers.",
      inputSchema: BROWSER_TOOL_INPUTS.doctor,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_args, extra) =>
      safeResult(() => runBrowserUse(["--doctor"], "", extra.signal))
  )
  server.registerTool(
    "mako_browser_exec",
    {
      description:
        "Run bounded Python against the user's existing local Chrome through Browser Use and CDP. Helpers such as ensure_real_tab, page_info, new_tab, cdp, js, click_at_xy, and wait_for_load are preloaded. Local only; never starts or offers a hosted browser.",
      inputSchema: BROWSER_TOOL_INPUTS.exec,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ source }, extra) =>
      safeResult(() => runBrowserUse([], source, extra.signal))
  )
  return server
}

export async function startBrowserToolsServer(): Promise<void> {
  await createBrowserToolsServer().connect(new StdioServerTransport())
}

function reportStartupFailure(error: Error): void {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  void startBrowserToolsServer().catch(reportStartupFailure)
}
