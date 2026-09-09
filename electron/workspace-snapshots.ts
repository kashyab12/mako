import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs"
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
} from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"
import { z } from "zod"
import {
  RewindPlanSchema,
  WorkspaceSnapshotSchema,
  type RewindPlan,
  type RewindPreview,
  type WorkspaceSnapshot,
} from "./contracts/workspace-snapshots.js"

const execute = promisify(execFile)
const oid = z.string().regex(/^[a-f0-9]{40,64}$/)
const RecordSchema = WorkspaceSnapshotSchema.extend({
  gitDir: z.string(),
  head: z.string(),
  tree: oid,
  indexDigest: z.union([
    z.literal("absent"),
    z.string().regex(/^[a-f0-9]{64}$/),
  ]),
})
type SnapshotRecord = z.infer<typeof RecordSchema>
const OperationSchema = z.object({
  plan: RewindPlanSchema,
  backupId: z.string().uuid(),
  state: z.enum(["applying", "completed"]),
})
type RestoreOperation = z.infer<typeof OperationSchema>
const RowSchema = z.object({ value: z.string() })
interface ActiveRun {
  scope: string
  error?: string
}
const LockSchema = z.object({
  owner: z.literal("mako-snapshots"),
  pid: z.number().int(),
  token: z.string().uuid(),
})

async function git(
  cwd: string,
  args: string[],
  index?: string,
  input?: string
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Mako",
    GIT_AUTHOR_EMAIL: "mako@localhost",
    GIT_COMMITTER_NAME: "Mako",
    GIT_COMMITTER_EMAIL: "mako@localhost",
  }
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"])
    delete env[key]
  if (index) env.GIT_INDEX_FILE = index
  const result = execute(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }
  )
  if (input !== undefined) result.child.stdin?.end(input)
  const { stdout } = await result
  return stdout
}

/** Only remove our own abandoned locks. A Git/user lock is never guessed stale. */
function acquireLock(path: string): () => void {
  if (existsSync(path)) {
    const previous = parseLock(path)
    if (previous) {
      try {
        process.kill(previous.pid, 0)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          unlinkSync(path)
      }
    }
  }
  const value = {
    owner: "mako-snapshots",
    pid: process.pid,
    token: randomUUID(),
  }
  try {
    writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  } catch (error) {
    throw new Error(
      "The workspace is busy. Finish the other Git or checkpoint operation and retry.",
      { cause: error }
    )
  }
  return () => {
    const current = parseLock(path)
    if (current && current.token === value.token) unlinkSync(path)
  }
}
function parseLock(path: string): z.infer<typeof LockSchema> | null {
  try {
    const result = LockSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** Workspace-wide Git checkpoints, with a separate index and a durable restore intent.
 * Restoring never moves HEAD. A retry completes the same fork, or refuses any edits
 * made since the interrupted operation. Native provider history is never rolled back.
 */
export class WorkspaceSnapshots {
  private readonly db: DatabaseSync
  private readonly busy = new Set<string>()
  private readonly runs = new Map<string, ActiveRun>()
  private readonly root: string
  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, "snapshots.sqlite"))
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS restores (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  }

  close(): void {
    this.db.close()
  }

  pending(): RewindPlan[] {
    return this.db
      .prepare("SELECT value FROM restores")
      .all()
      .map((row) =>
        OperationSchema.parse(JSON.parse(RowSchema.parse(row).value))
      )
      .filter((operation) => operation.state === "applying")
      .map((operation) => operation.plan)
  }

  async assertAvailable(cwd: string): Promise<void> {
    const path = await realpath(cwd)
    const scopes = [
      ...this.busy,
      ...this.pending().map((plan) => this.get(plan.targetId).scope),
    ]
    if (
      scopes.some((scope) => {
        const child = relative(scope, path)
        return child === "" || (!child.startsWith("../") && child !== "..")
      })
    )
      throw new Error(
        "A workspace checkpoint or rewind is unfinished. Wait for it to finish before starting another turn."
      )
  }

  async beginRun(id: string, cwd: string): Promise<WorkspaceSnapshot> {
    const scope = await this.scope(cwd)
    const run: ActiveRun = { scope }
    for (const other of this.runs.values()) {
      if (other.scope !== scope) continue
      other.error =
        "Another agent used this workspace during the turn. A coordinated checkpoint is unavailable."
      run.error = other.error
    }
    this.runs.set(id, run)
    try {
      if (run.error) throw new Error(run.error)
      return await this.capture(scope)
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async endRun(id: string): Promise<WorkspaceSnapshot> {
    const run = this.runs.get(id)
    if (!run)
      throw new Error("No workspace checkpoint was captured before this turn")
    try {
      if (run.error) throw new Error(run.error)
      return await this.capture(run.scope)
    } finally {
      this.runs.delete(id)
    }
  }

  abandonRun(id: string): void {
    this.runs.delete(id)
  }

  private assertIdle(scope: string): void {
    if ([...this.runs.values()].some((run) => run.scope === scope))
      throw new Error(
        "Wait for every agent using this workspace to finish before rewinding"
      )
  }

  async capture(cwd: string): Promise<WorkspaceSnapshot> {
    const scope = await this.scope(cwd)
    return this.locked(scope, async (gitDir) => {
      this.assertNoPending(scope)
      return this.summary(await this.captureLocked(scope, gitDir))
    })
  }

  async preview(targetId: string): Promise<RewindPreview> {
    const target = this.get(targetId)
    this.assertIdle(target.scope)
    return this.locked(target.scope, async (gitDir) => {
      this.assertNoPending(target.scope)
      await this.validateRepository(target)
      const current = await this.captureLocked(target.scope, gitDir)
      const paths = await this.changedPaths(current, target)
      return {
        target: this.summary(target),
        current: this.summary(current),
        changedFiles: paths.slice(0, 100),
        changedFileCount: paths.length,
        stagingChanged: target.indexDigest !== current.indexDigest,
      }
    })
  }

  async restore(input: RewindPlan, complete: () => void): Promise<void> {
    const plan = RewindPlanSchema.parse(input)
    const target = this.get(plan.targetId)
    this.assertIdle(target.scope)
    await this.locked(target.scope, async (gitDir) => {
      const row = this.db
        .prepare("SELECT value FROM restores WHERE id=?")
        .get(plan.fork.id)
      let operation = row
        ? OperationSchema.parse(JSON.parse(RowSchema.parse(row).value))
        : null
      if (operation && JSON.stringify(operation.plan) !== JSON.stringify(plan))
        throw new Error("This rewind ID belongs to another operation")
      if (operation?.state === "completed") {
        complete()
        return
      }
      this.assertNoPending(target.scope, plan.fork.id)
      await this.validateRepository(target)
      const current = await this.captureLocked(target.scope, gitDir)
      if (!operation) {
        const expected = this.get(plan.expectedId)
        if (!this.sameState(current, expected))
          throw new Error(
            "The workspace changed after the preview. Review a new preview before rewinding."
          )
        operation = { plan, backupId: current.id, state: "applying" }
        this.saveOperation(operation)
      }
      const backup = this.get(operation.backupId)
      await this.assertRecoverable(current, backup, target)
      // The intent is durable before the first file changes. If the process dies,
      // recovery validates each path against the two recorded states before proceeding.
      try {
        await this.restoreFiles(current, target)
        complete()
      } catch (error) {
        try {
          const partial = await this.captureLocked(target.scope, gitDir)
          await this.assertRecoverable(partial, backup, target)
          await this.restoreFiles(partial, backup)
          this.db.prepare("DELETE FROM restores WHERE id=?").run(plan.fork.id)
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "Rewind failed and recovery is still required. The saved workspace backup has been retained.",
            { cause: recoveryError }
          )
        }
        throw error
      }
      // A journal commit followed by a receipt-write failure remains pending;
      // recovery repeats the idempotent completion, never undoes a committed fork.
      this.saveOperation({ ...operation, state: "completed" })
    })
  }

  private saveOperation(operation: RestoreOperation): void {
    this.db
      .prepare("INSERT OR REPLACE INTO restores VALUES (?, ?)")
      .run(operation.plan.fork.id, JSON.stringify(operation))
  }
  private assertNoPending(scope: string, except?: string): void {
    if (
      this.pending().some(
        (plan) =>
          plan.fork.id !== except && this.get(plan.targetId).scope === scope
      )
    )
      throw new Error(
        "This workspace has an unfinished rewind. Recover it before continuing."
      )
  }
  private get(id: string): SnapshotRecord {
    z.string().uuid().parse(id)
    const row = this.db
      .prepare("SELECT value FROM snapshots WHERE id=?")
      .get(id)
    if (!row)
      throw new Error("This workspace checkpoint is no longer available")
    return RecordSchema.parse(JSON.parse(RowSchema.parse(row).value))
  }
  private summary(record: SnapshotRecord): WorkspaceSnapshot {
    return WorkspaceSnapshotSchema.parse(record)
  }
  private async scope(cwd: string): Promise<string> {
    try {
      return await realpath(
        (await git(cwd, ["rev-parse", "--show-toplevel"])).trim()
      )
    } catch (error) {
      throw new Error(
        "Workspace checkpoints currently require a Git repository.",
        { cause: error }
      )
    }
  }
  private async locked<T>(
    scope: string,
    work: (gitDir: string) => Promise<T>
  ): Promise<T> {
    if (this.busy.has(scope))
      throw new Error("Another checkpoint operation is using this workspace")
    this.busy.add(scope)
    const releases: (() => void)[] = []
    try {
      const gitDir = (
        await git(scope, ["rev-parse", "--absolute-git-dir"])
      ).trim()
      releases.push(acquireLock(join(gitDir, "mako-snapshots.lock")))
      releases.push(acquireLock(join(gitDir, "index.lock")))
      return await work(gitDir)
    } finally {
      for (const release of releases.reverse()) release()
      this.busy.delete(scope)
    }
  }
  private async head(scope: string): Promise<string> {
    const branch = (
      await git(scope, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")
    ).trim()
    const revision = (
      await git(scope, ["rev-parse", "--verify", "HEAD"]).catch(() => "unborn")
    ).trim()
    return `${branch}:${revision}`
  }
  private async validateRepository(record: SnapshotRecord): Promise<void> {
    if (
      (await this.scope(record.scope)) !== record.scope ||
      (await git(record.scope, ["rev-parse", "--absolute-git-dir"])).trim() !==
        record.gitDir ||
      (await this.head(record.scope)) !== record.head
    )
      throw new Error(
        "The Git branch or HEAD changed since this checkpoint. Rewinding files across that change is not supported."
      )
    await git(record.scope, ["cat-file", "-e", `${record.tree}^{tree}`])
    if (record.indexDigest !== "absent") {
      const bytes = await readFile(join(this.root, record.id, "index"))
      if (
        createHash("sha256").update(bytes).digest("hex") !== record.indexDigest
      )
        throw new Error(
          "The saved staging checkpoint is damaged. No files were restored."
        )
      const entries = await git(
        record.scope,
        ["ls-files", "--stage", "-z"],
        join(this.root, record.id, "index")
      )
      const objects = entries
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const match = /^\d+ ([a-f0-9]{40,64}) 0\t/.exec(entry)
          if (!match)
            throw new Error("The saved staging checkpoint is damaged.")
          return match[1]
        })
      if (objects.length) {
        const available = await git(
          record.scope,
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          undefined,
          `${objects.join("\n")}\n`
        )
        if (
          available !==
          `${objects.map((object) => `${object} blob`).join("\n")}\n`
        )
          throw new Error(
            "The saved staging checkpoint has missing Git objects. No files were restored."
          )
      }
    }
  }
  private sameState(left: SnapshotRecord, right: SnapshotRecord): boolean {
    return (
      left.scope === right.scope &&
      left.gitDir === right.gitDir &&
      left.head === right.head &&
      left.tree === right.tree &&
      left.indexDigest === right.indexDigest
    )
  }
  private async captureLocked(
    scope: string,
    gitDir: string
  ): Promise<SnapshotRecord> {
    const sparse = (
      await git(scope, ["config", "--bool", "core.sparseCheckout"]).catch(
        () => "false"
      )
    ).trim()
    if (sparse === "true")
      throw new Error(
        "Workspace checkpoints do not support sparse checkouts yet"
      )
    const flags = await git(scope, ["ls-files", "-v", "-z"])
    if (flags.split("\0").some((entry) => /^[a-zS] /.test(entry)))
      throw new Error(
        "Clear assume-unchanged and skip-worktree flags before using workspace checkpoints"
      )
    const tracked = await git(scope, ["ls-files", "--stage", "-z"])
    if (
      tracked
        .split("\0")
        .some(
          (line) =>
            line.startsWith("160000 ") || /^\d+ [a-f0-9]+ [123]\t/.test(line)
        )
    )
      throw new Error(
        "Resolve index conflicts or remove submodules from this workspace before using checkpoints"
      )
    const paths = [
      ...new Set(
        (
          await git(scope, [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean)
      ),
    ]
    if (paths.length > 20_000)
      throw new Error("Workspace checkpoint exceeds the 20,000-file limit")
    let bytes = 0
    for (let offset = 0; offset < paths.length; offset += 64) {
      const sizes = await Promise.all(
        paths.slice(offset, offset + 64).map(async (path) => {
          try {
            return (await lstat(join(scope, path))).size
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ENOTDIR")
            )
              return 0
            throw error
          }
        })
      )
      bytes += sizes.reduce((sum, size) => sum + size, 0)
      if (bytes > 256 * 1024 * 1024)
        throw new Error("Workspace checkpoint exceeds the 256 MB file limit")
    }
    const id = randomUUID()
    const directory = join(this.root, id)
    mkdirSync(directory)
    const index = join(directory, "index")
    const workingIndex = join(directory, "working-index")
    const userIndex = join(gitDir, "index")
    const hasIndex = existsSync(userIndex)
    const head = await this.head(scope)
    try {
      if (hasIndex) {
        await copyFile(userIndex, index)
        // Expand split indexes so retained snapshots do not depend on sharedindex GC.
        await git(scope, ["update-index", "--no-split-index"], index)
      } else {
        await git(scope, ["read-tree", "--empty"], workingIndex)
      }
      // The live index can move on immediately. Keep its saved tree reachable
      // from our checkpoint ref so Git GC cannot discard staged-only blobs.
      const stagedTree = hasIndex
        ? (await git(scope, ["write-tree"], index)).trim()
        : undefined
      if (hasIndex) await copyFile(index, workingIndex)
      const indexDigest = hasIndex
        ? createHash("sha256")
            .update(await readFile(index))
            .digest("hex")
        : "absent"
      await git(scope, ["add", "-A", "--", "."], workingIndex)
      const stagedEntries = await git(
        scope,
        ["ls-files", "--stage", "-z"],
        workingIndex
      )
      if (
        stagedEntries.split("\0").some((entry) => entry.startsWith("160000 "))
      )
        throw new Error(
          "Workspace checkpoints cannot include embedded Git repositories"
        )
      const tree = (await git(scope, ["write-tree"], workingIndex)).trim()
      if ((await this.head(scope)) !== head)
        throw new Error("Git HEAD changed while capturing the workspace")
      const parents = stagedTree
        ? [
            "-p",
            (
              await git(scope, [
                "commit-tree",
                stagedTree,
                "-m",
                `Mako staging checkpoint ${id}`,
              ])
            ).trim(),
          ]
        : []
      const commit = (
        await git(scope, [
          "commit-tree",
          tree,
          ...parents,
          "-m",
          `Mako checkpoint ${id}`,
        ])
      ).trim()
      await git(scope, ["update-ref", `refs/mako/checkpoints/${id}`, commit])
      await rm(workingIndex, { force: true })
      const record: SnapshotRecord = {
        id,
        scope,
        createdAt: Date.now(),
        files: paths.length,
        gitDir,
        head,
        tree,
        indexDigest,
      }
      this.db
        .prepare("INSERT INTO snapshots VALUES (?, ?)")
        .run(id, JSON.stringify(record))
      return record
    } catch (error) {
      await git(scope, [
        "update-ref",
        "-d",
        `refs/mako/checkpoints/${id}`,
      ]).catch(() => {})
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
  private async changedPaths(
    from: SnapshotRecord,
    to: SnapshotRecord
  ): Promise<string[]> {
    return (
      await git(from.scope, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        from.tree,
        to.tree,
      ])
    )
      .split("\0")
      .filter(Boolean)
  }
  private async treeFiles(
    record: SnapshotRecord
  ): Promise<Map<string, string>> {
    const lines = (await git(record.scope, ["ls-tree", "-rz", record.tree]))
      .split("\0")
      .filter(Boolean)
    return new Map(
      lines.map((line) => {
        const separator = line.indexOf("\t")
        return [line.slice(separator + 1), line.slice(0, separator)]
      })
    )
  }
  private async assertRecoverable(
    current: SnapshotRecord,
    backup: SnapshotRecord,
    target: SnapshotRecord
  ): Promise<void> {
    if (
      current.head !== target.head ||
      current.scope !== target.scope ||
      current.gitDir !== target.gitDir
    )
      throw new Error("The workspace identity changed during rewind")
    if (
      current.indexDigest !== backup.indexDigest &&
      current.indexDigest !== target.indexDigest
    )
      throw new Error(
        "Staged changes were modified after rewind began. Recovery has stopped to preserve them."
      )
    const [now, before, after] = await Promise.all(
      [current, backup, target].map((record) => this.treeFiles(record))
    )
    const paths = new Set([...now.keys(), ...before.keys(), ...after.keys()])
    for (const path of paths)
      if (
        now.get(path) !== before.get(path) &&
        now.get(path) !== after.get(path)
      )
        throw new Error(
          `File changed after rewind began: ${path}. Recovery has stopped to preserve it.`
        )
  }
  private async ownedDirectory(
    scope: string,
    path: string,
    files: Map<string, string>
  ): Promise<boolean> {
    const info = await lstat(join(scope, path))
    if (!info.isDirectory()) return false
    const pending = [path]
    let seen = 0
    while (pending.length) {
      const directory = pending.pop()
      if (directory === undefined) break
      for (const entry of await readdir(join(scope, directory), {
        withFileTypes: true,
      })) {
        if (++seen > 20_000) return false
        const child = `${directory}/${entry.name}`
        if (entry.isDirectory()) pending.push(child)
        else if (!files.has(child)) return false
      }
    }
    return true
  }

  private async restoreFiles(
    current: SnapshotRecord,
    target: SnapshotRecord
  ): Promise<void> {
    await this.validateRepository(target)
    const currentFiles = await this.treeFiles(current)
    const targetFiles = await this.treeFiles(target)
    // read-tree --reset may overwrite ignored files. Refuse such collisions before
    // it runs, and never traverse a directory replaced with an outside symlink.
    for (const path of await this.changedPaths(current, target)) {
      let parent = dirname(join(target.scope, path))
      while (parent !== target.scope) {
        const stat = await lstat(parent).catch(() => null)
        if (stat?.isSymbolicLink())
          throw new Error(
            `Cannot rewind through a symbolic-link directory: ${path}`
          )
        parent = dirname(parent)
      }
      if (
        targetFiles.has(path) &&
        !currentFiles.has(path) &&
        existsSync(join(target.scope, path)) &&
        !(await this.ownedDirectory(target.scope, path, currentFiles))
      )
        throw new Error(
          `Rewind would overwrite an ignored or unrecorded path: ${path}`
        )
    }
    const temporary = await mkdtemp(join(this.root, "restore-"))
    try {
      const index = join(temporary, "index")
      await git(target.scope, ["read-tree", current.tree], index)
      await git(
        target.scope,
        ["read-tree", "--reset", "-u", target.tree],
        index
      )
      const destination = join(target.gitDir, "index")
      if (target.indexDigest !== "absent") {
        // The actual index.lock is held by locked(). Rename on the same filesystem.
        const staged = join(target.gitDir, `mako-index-${randomUUID()}`)
        try {
          await copyFile(join(this.root, target.id, "index"), staged)
          const { rename } = await import("node:fs/promises")
          await rename(staged, destination)
        } finally {
          await rm(staged, { force: true })
        }
      } else await rm(destination, { force: true })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
