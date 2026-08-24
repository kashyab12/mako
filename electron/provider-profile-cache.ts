import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import type { HarnessProfile } from "./shared.js"

const scalarSchema = z.union([z.string(), z.boolean()])
const selectValueSchema = z.object({ value: z.string(), label: z.string() })
const optionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select"),
    id: z.string(),
    label: z.string(),
    current: z.string().optional(),
    values: z.array(selectValueSchema),
    presentation: z.enum(["select", "toggle"]).optional(),
  }),
  z.object({
    kind: z.literal("boolean"),
    id: z.string(),
    label: z.string(),
    current: z.boolean(),
  }),
])
const variantSchema = z.object({
  id: z.string(),
  label: z.string(),
  values: z.record(z.string(), scalarSchema),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  description: z.string().optional(),
})
const modelSchema = z.object({
  id: z.string(),
  launchId: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  options: z.array(optionSchema),
  variants: z.array(variantSchema).optional(),
})
const profileSchema = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  transport: z.enum(["acp", "app-server", "remote"]),
  models: z.array(modelSchema),
  defaultModel: z.string().optional(),
  configuredModel: z.string().optional(),
  capabilities: z.array(z.string()),
  error: z.string().optional(),
})
const entrySchema = z.object({ hash: z.string(), savedAt: z.number() })
const fileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), entrySchema),
  snapshots: z.record(z.string(), profileSchema),
})

type CacheFile = z.infer<typeof fileSchema>

const EMPTY: CacheFile = { version: 1, entries: {}, snapshots: {} }
const MAX_ENTRIES = 64

function cachePath(): string {
  return join(homedir(), ".mako", "provider-profiles.json")
}

function profileHash(profile: HarnessProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex")
}

export class ProviderProfileCache {
  private file: CacheFile = structuredClone(EMPTY)
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()
  private readonly path: string

  constructor(path = cachePath()) {
    this.path = path
  }

  async get(key: string): Promise<HarnessProfile | null> {
    await this.load()
    const entry = this.file.entries[key]
    return entry ? (this.file.snapshots[entry.hash] ?? null) : null
  }

  async put(key: string, profile: HarnessProfile): Promise<void> {
    await this.load()
    const hash = profileHash(profile)
    this.file.snapshots[hash] = profile
    this.file.entries[key] = { hash, savedAt: Date.now() }
    this.trim()
    this.writes = this.writes.then(() => this.persist())
    await this.writes
  }

  async clear(key?: string): Promise<void> {
    await this.load()
    if (key) delete this.file.entries[key]
    else this.file = structuredClone(EMPTY)
    this.trim()
    this.writes = this.writes.then(() => this.persist())
    await this.writes
  }

  private async load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"))
        const result = fileSchema.safeParse(parsed)
        this.file = result.success ? result.data : structuredClone(EMPTY)
      } catch {
        this.file = structuredClone(EMPTY)
      }
    })()
    await this.loaded
  }

  private trim(): void {
    const entries = Object.entries(this.file.entries).sort(
      ([, left], [, right]) => right.savedAt - left.savedAt
    )
    this.file.entries = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
    const retained = new Set(Object.values(this.file.entries).map((entry) => entry.hash))
    this.file.snapshots = Object.fromEntries(
      Object.entries(this.file.snapshots).filter(([hash]) => retained.has(hash))
    )
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.path)
    const temp = `${this.path}.${process.pid}.tmp`
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(temp, JSON.stringify(this.file), { encoding: "utf8", mode: 0o600 })
    await rename(temp, this.path)
  }
}

export const providerProfileCache = new ProviderProfileCache()
