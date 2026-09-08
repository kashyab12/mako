import { open, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { processIdentityMatches } from "../process-liveness.js"
import type { ProviderActivitySession } from "../process-probe.js"

const snapshot = z.object({
  pid: z.number().int().positive(),
  startedAt: z.number(),
  updatedAt: z.number(),
  overflow: z.literal(false),
  sessions: z
    .array(
      z.object({
        nativeId: z.string().regex(/^ses/).max(160),
        status: z.enum(["active", "needs-input"]),
      })
    )
    .max(4096),
})

export async function openCodeRegistryActivity(
  root: string,
  signal: AbortSignal
): Promise<ProviderActivitySession[]> {
  let files: string[]
  try {
    files = await readdir(root)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return []
    throw error
  }
  const sessions: ProviderActivitySession[] = []
  const identities = new Map<number, Promise<boolean>>()
  let read = 0
  for (const name of files) {
    signal.throwIfAborted()
    const match = name.match(/^(\d+)-[a-f0-9-]{36}\.json$/)
    if (!match) continue
    const pid = Number(match[1])
    const path = join(root, name)
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        await rm(path, { force: true })
        continue
      }
      throw error
    }
    if (++read > 256) throw new Error("Too many live OpenCode activity records")
    const file = await open(path, "r")
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1)
      const { bytesRead } = await file.read(buffer)
      if (bytesRead > 1024 * 1024)
        throw new Error("OpenCode activity record exceeds the read limit")
      const value = snapshot.parse(
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
      )
      if (value.pid !== pid)
        throw new Error(
          "OpenCode activity identity does not match its registration"
        )
      if (!value.sessions.length) continue
      if (
        Date.now() - value.updatedAt > 15_000 ||
        value.updatedAt - Date.now() > 5_000
      )
        throw new Error("OpenCode activity heartbeat is stale")
      let alive = identities.get(pid)
      if (!alive) {
        alive = processIdentityMatches({
          pid,
          startedAt: value.startedAt,
          signal,
        })
        identities.set(pid, alive)
      }
      if (await alive) sessions.push(...value.sessions)
    } finally {
      await file.close()
    }
  }
  return sessions
}
