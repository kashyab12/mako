import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { z } from "zod"
import { type ArchiveCommand, type ThreadArchiveSnapshot } from "./contracts/thread-lifecycle.js"

export class ThreadArchives {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS archives (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK (id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO revision VALUES (1,0)")
  }
  snapshot(): ThreadArchiveSnapshot {
    const revision = z.object({ value: z.number() }).parse(this.db.prepare("SELECT value FROM revision WHERE id=1").get()).value
    const keys = this.db.prepare("SELECT key FROM archives ORDER BY key").all().map((row) => z.object({ key: z.string() }).parse(row).key)
    return { revision, keys }
  }
  set(command: ArchiveCommand, keys: string[]): ThreadArchiveSnapshot {
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex")
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const old = this.db.prepare("SELECT digest FROM receipts WHERE id=?").get(command.id)
      if (old) {
        if (z.object({ digest: z.string() }).parse(old).digest !== digest) throw new Error("This archive request ID was already used for another action")
      } else {
        const statement = this.db.prepare(command.archived ? "INSERT OR IGNORE INTO archives VALUES (?)" : "DELETE FROM archives WHERE key=?")
        for (const key of new Set(keys)) statement.run(key)
        this.db.prepare("INSERT INTO receipts VALUES (?, ?)").run(command.id, digest)
        this.db.prepare("UPDATE revision SET value=value+1 WHERE id=1").run()
      }
      this.db.exec("COMMIT")
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
    return this.snapshot()
  }
  close() { this.db.close() }
}
