import { NativeAgentRosterSchema } from "./contracts/native-agents.js"
import {
  ModelOptionSchema,
  SessionSettingsSchema,
} from "@mako/sessions/settings"
import {
  ContextManifestSchema,
  ConversationControlSchema,
  PromptAttachmentSchema,
} from "./contracts/conversation-control.js"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { ThreadEntrySchema, ThreadRefSchema } from "@mako/sessions"
import { LiveBlockSchema } from "./contracts/live-content.js"
import { RunSnapshotsSchema } from "./contracts/workspace-snapshots.js"
import type { LiveSnapshot } from "./contracts/live-conversations.js"

const question = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isSecret: z.boolean(),
  allowOther: z.boolean(),
  required: z.boolean().optional(),
  valueType: z
    .enum(["string", "number", "integer", "boolean", "string-array"])
    .optional(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      value: z.string().optional(),
    })
  ),
  defaultValues: z.array(z.string()).optional(),
})
export const LiveRequestSchema = z.object({
  snapshots: RunSnapshotsSchema.optional(),
  tuning: SessionSettingsSchema.optional(),
  inputDigest: z.string().optional(),
  nativeRun: z
    .object({
      bindingId: z.string(),
      runId: z.string(),
      forkId: z.string().optional(),
    })
    .optional(),
  id: z.string().uuid(),
  text: z.string().max(1_000_000),
  attachments: z.array(PromptAttachmentSchema),
  displayText: z.string().optional(),
  context: z.array(ContextManifestSchema).optional(),
  status: z.enum([
    "queued",
    "held",
    "canceled",
    "dispatching",
    "completed",
    "failed",
    "uncertain",
    "interrupted",
  ]),
  error: z.string().optional(),
})
const MetadataSchema = z.object({
  nativeAgents: NativeAgentRosterSchema.optional(),
  control: ConversationControlSchema.optional(),
  session: z.object({
    connection: z.enum(["starting", "connected", "disconnected"]),
    id: z.string(),
    nativeId: z.string().optional(),
    harness: z.string(),
    cwd: z.string(),
    title: z.string().optional(),
    status: z.enum(["starting", "ready", "running", "failed", "closed"]),
    modes: z.array(z.object({ id: z.string(), name: z.string() })),
    currentMode: z.string().nullable(),
    configOptions: z.array(ModelOptionSchema),
    settings: SessionSettingsSchema.optional(),
    lastStop: z.string().optional(),
    error: z.string().optional(),
  }),
  revision: z.number().int().nonnegative(),
  threadPath: z.string().optional(),
  createdAt: z.number(),
  permissions: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string(),
      title: z.string(),
      kind: z.string().optional(),
      options: z.array(
        z.object({
          optionId: z.string(),
          name: z.string(),
          kind: z.string().optional(),
        })
      ),
      questions: z.array(question).optional(),
    })
  ),
})
const BaseSchema = z
  .object({
    ref: ThreadRefSchema,
    entries: z.array(ThreadEntrySchema),
    checkpoint: z.number().optional(),
    start: z.number(),
    total: z.number(),
    hasEarlier: z.boolean(),
  })
  .nullable()
const RowSchema = z.object({ value: z.string() })

/** One independent journal per conversation. Only changed blocks and requests are written. */
export class LiveJournal {
  private readonly db: DatabaseSync
  constructor(root: string, id: string) {
    z.string().uuid().parse(id)
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, `${id}.sqlite`))
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS base (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  summary() {
    const row = this.db.prepare("SELECT value FROM metadata WHERE id=1").get()
    if (!row) return null
    const { session, revision, threadPath, createdAt, control } =
      MetadataSchema.parse(JSON.parse(RowSchema.parse(row).value))
    return {
      session,
      revision,
      threadPath,
      createdAt,
      nativePaths: control?.bindings.flatMap((binding) =>
        binding.path ? [binding.path] : []
      ),
    }
  }

  read(): LiveSnapshot | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE id=1").get()
    if (!row) return null
    const metadata = MetadataSchema.parse(
      JSON.parse(RowSchema.parse(row).value)
    )
    const base = this.db.prepare("SELECT value FROM base WHERE id=1").get()
    return {
      ...metadata,
      base: base
        ? BaseSchema.parse(JSON.parse(RowSchema.parse(base).value))
        : null,
      blocks: this.db
        .prepare("SELECT value FROM blocks ORDER BY id")
        .all()
        .map((row) =>
          LiveBlockSchema.parse(JSON.parse(RowSchema.parse(row).value))
        ),
      requests: this.db
        .prepare("SELECT value FROM requests ORDER BY rowid")
        .all()
        .map((row) =>
          LiveRequestSchema.parse(JSON.parse(RowSchema.parse(row).value))
        ),
    }
  }

  commit(next: LiveSnapshot, previous?: LiveSnapshot): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const { blocks, requests, base, ...metadata } = next
      this.db
        .prepare("INSERT OR REPLACE INTO metadata VALUES (1, ?)")
        .run(JSON.stringify(metadata))
      if (!previous || base !== previous.base)
        this.db
          .prepare("INSERT OR REPLACE INTO base VALUES (1, ?)")
          .run(JSON.stringify(base))
      const upsertBlock = this.db.prepare(
        "INSERT OR REPLACE INTO blocks VALUES (?, ?)"
      )
      for (let index = 0; index < blocks.length; index++) {
        if (blocks[index] !== previous?.blocks[index])
          upsertBlock.run(index, JSON.stringify(blocks[index]))
      }
      if (previous && blocks.length < previous.blocks.length)
        this.db.prepare("DELETE FROM blocks WHERE id>=?").run(blocks.length)
      const oldRequests = new Map(
        previous?.requests.map((request) => [request.id, request])
      )
      const upsertRequest = this.db.prepare(
        "INSERT INTO requests VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value"
      )
      for (const request of requests)
        if (request !== oldRequests.get(request.id))
          upsertRequest.run(request.id, JSON.stringify(request))
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}

export function journalIds(root: string): string[] {
  mkdirSync(root, { recursive: true })
  return readdirSync(root).flatMap((name) => {
    if (!name.endsWith(".sqlite")) return []
    const id = z.string().uuid().safeParse(name.slice(0, -7))
    return id.success ? [id.data] : []
  })
}
