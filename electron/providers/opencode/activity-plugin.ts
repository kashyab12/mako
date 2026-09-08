import { z } from "zod"
// Mako activity observer. Bundled as a standalone OpenCode plugin.
import { randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const activityEvent = z.object({
  type: z.string(),
  properties: z.object({
    sessionID: z.string().regex(/^ses[a-zA-Z0-9_-]{1,157}$/),
    status: z.object({ type: z.enum(["busy", "retry", "idle"]) }).optional(),
  }),
})

export default async function MakoActivityPlugin() {
  const root = join(homedir(), ".mako", "activity", "opencode")
  const path = join(root, `${process.pid}-${randomUUID()}.json`)
  const startedAt = Date.now() - process.uptime() * 1000
  const sessions = new Map<string, "active" | "needs-input">()
  let disposed = false
  let overflow = false
  let dirty = false
  let writing: Promise<void> | undefined
  const flush = async () => {
    while (dirty && !disposed) {
      dirty = false
      const value = {
        pid: process.pid,
        startedAt,
        updatedAt: Date.now(),
        overflow,
        sessions: [...sessions].map(([nativeId, status]) => ({
          nativeId,
          status,
        })),
      }
      try {
        await mkdir(root, { recursive: true, mode: 0o700 })
        await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
        await rename(`${path}.tmp`, path)
      } catch {
        /* Observation must never fail a provider turn. The host expires unreadable/stale records. */
      }
    }
  }
  const publish = () => {
    dirty = true
    writing ??= flush().finally(() => {
      writing = undefined
      if (dirty && !disposed) publish()
    })
  }
  const heartbeat = setInterval(() => {
    if (sessions.size) publish()
  }, 5_000)
  heartbeat.unref()
  return {
    async event({ event }: { event: unknown }) {
      if (disposed || overflow) return
      const parsed = activityEvent.safeParse(event)
      if (!parsed.success) return
      const { type, properties } = parsed.data
      const id = properties.sessionID
      if (type === "session.status" && properties.status) {
        const status = properties.status.type
        if (status === "busy" || status === "retry") sessions.set(id, "active")
        else if (status === "idle") sessions.delete(id)
        else return
      } else if (type === "permission.asked" || type === "question.asked")
        sessions.set(id, "needs-input")
      else if (
        type === "permission.replied" ||
        type === "question.replied" ||
        type === "question.rejected"
      )
        sessions.set(id, "active")
      else if (type === "session.idle" || type === "session.error")
        sessions.delete(id)
      else return
      if (sessions.size > 4096) {
        sessions.clear()
        overflow = true
      }
      publish()
    },
    async dispose() {
      disposed = true
      clearInterval(heartbeat)
      await writing
      await Promise.all([
        rm(path, { force: true }),
        rm(`${path}.tmp`, { force: true }),
      ]).catch(() => {})
    },
  }
}
