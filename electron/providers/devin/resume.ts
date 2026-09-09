import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { ProviderBinding } from "../../contracts/conversation-control.js"

const rowSchema = z.object({ main_chain_id: z.number().nullable(), model: z.string().nullable(), working_directory: z.string() })

export function devinResumePolicy(directory = join(homedir(), ".local", "share", "devin", "cli")) {
  const database = join(directory, "sessions.db")
  const identity = (path: string) => {
    const id = path.startsWith(`${database}#`) ? path.slice(database.length + 1) : ""
    return /^[\w-]+$/.test(id) ? id : undefined
  }
  const checkpoint = async (path: string): Promise<string | undefined> => {
    const id = identity(path)
    if (!id) return undefined
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(database, { readOnly: true })
      const row = rowSchema.safeParse(db.prepare("SELECT main_chain_id, model, working_directory FROM sessions WHERE id = ? AND hidden = 0").get(id))
      return row.success ? createHash("sha256").update(JSON.stringify([id, row.data])).digest("hex") : undefined
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
  const canResumeBinding = async (binding: ProviderBinding): Promise<boolean> => {
    if (!binding.nativeId || !binding.path || identity(binding.path) !== binding.nativeId) return false
    try {
      const file = await open(join(directory, "session_locks", `${binding.nativeId}.lock`), "r")
      let pid: number
      try {
        const bytes = Buffer.alloc(65)
        const read = await file.read(bytes, 0, bytes.length, 0)
        if (read.bytesRead === bytes.length) return false
        const value = bytes.subarray(0, read.bytesRead).toString("utf8").trim()
        if (!/^\d+$/.test(value)) return false
        pid = Number(value)
        if (!Number.isSafeInteger(pid) || pid <= 0) return false
      } finally {
        await file.close()
      }
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return false
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false
    }
    const current = await checkpoint(binding.path)
    return current !== undefined && (binding.checkpoint === undefined || current === binding.checkpoint)
  }
  return { checkpoint, canResumeBinding }
}
