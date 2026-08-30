import { spawn } from "node:child_process"
import type { ProviderActivityResult } from "./process-probe.js"

export type OpenFilesResult =
  | { kind: "available"; paths: string[]; processFound: boolean }
  | Extract<ProviderActivityResult, { kind: "unavailable" }>

export async function probeOpenFiles({
  processNames,
  signal,
  accept,
}: {
  processNames: string[]
  signal: AbortSignal
  accept: (path: string) => boolean
}): Promise<OpenFilesResult> {
  if (process.platform === "win32")
    return { kind: "unavailable", reason: "unsupported" }
  const command = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof"
  return new Promise((resolve) => {
    const child = spawn(
      command,
      ["-Fn", ...processNames.flatMap((name) => ["-c", name])],
      { signal, stdio: ["ignore", "pipe", "ignore"] }
    )
    const paths = new Set<string>()
    let carry = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      carry += chunk
      const lines = carry.split("\n")
      carry = lines.pop() ?? ""
      if (carry.length > 64 * 1024) carry = ""
      for (const line of lines) {
        if (!line.startsWith("n")) continue
        const path = line.slice(1)
        if (accept(path)) paths.add(path)
      }
    })
    child.once("error", () =>
      resolve({
        kind: "unavailable",
        reason: signal.aborted ? "timeout" : "failed",
      })
    )
    child.once("close", (code) => {
      if (code === 0 || code === 1)
        resolve({
          kind: "available",
          paths: [...paths],
          processFound: code === 0,
        })
      else
        resolve({
          kind: "unavailable",
          reason: signal.aborted ? "timeout" : "failed",
        })
    })
  })
}
