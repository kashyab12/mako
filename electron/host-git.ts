import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type {
  GitCommitEntry,
  GitDiff,
  GitFile,
  GitFileStatus,
  GitStatus,
  SearchOptions,
} from "./shared.js"

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

const execFileAsync = promisify(execFile)

/** Untracked files above this size are not line-counted for the status list. */
const UNTRACKED_STAT_LIMIT = 2_000_000

async function git(root: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path)
    if (buf.includes(0)) return null
    return buf.toString("utf8")
  } catch {
    return null
  }
}

function statusFor(xy: string): GitFileStatus {
  if (xy === "??") return "untracked"
  if (xy.includes("R")) return "renamed"
  if (xy.includes("D")) return "deleted"
  if (xy.includes("A")) return "added"
  return "modified"
}

async function countLines(path: string): Promise<{ lines: number; binary: boolean }> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > UNTRACKED_STAT_LIMIT) return { lines: 0, binary: false }
    const buf = await readFile(path)
    if (buf.includes(0)) return { lines: 0, binary: true }
    if (buf.length === 0) return { lines: 0, binary: false }
    let lines = 1
    for (const byte of buf) if (byte === 10) lines += 1
    return { lines, binary: false }
  } catch {
    return { lines: 0, binary: false }
  }
}

export class WorkspaceGit {
  private cwdValue: string
  private gitRoot: string | null | undefined

  constructor(cwd: string) {
    this.cwdValue = cwd
  }

  get cwd(): string {
    return this.cwdValue
  }

  setCwd(cwd: string) {
    this.cwdValue = cwd
    this.gitRoot = undefined
  }

  async root(): Promise<string | null> {
    if (this.gitRoot !== undefined) return this.gitRoot
    const cwd = this.cwdValue
    const root = await findGitRoot(cwd)
    if (this.cwdValue === cwd) this.gitRoot = root
    return root
  }

  async status(): Promise<GitStatus> {
    const cwd = this.cwdValue
    const root = await this.root()
    if (!root) return { cwd, ahead: 0, behind: 0, files: [] }

    const [branchOut, statusOut, numstatOut, cachedOut, headOut] = await Promise.all([
      git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]),
      git(root, ["diff", "--numstat", "-z", "HEAD"]).catch(() => ""),
      git(root, ["diff", "--numstat", "-z", "--cached"]).catch(() => ""),
      git(root, ["rev-parse", "HEAD"]).catch(() => ""),
    ])

    // numstat -z emits "adds\tdels\tpath\0", with renames as three NUL fields.
    // Staged-only changes do not appear in `diff HEAD` once committed-to-index,
    // so both sides are parsed and merged; otherwise a staged file shows 0/0.
    const stats = parseNumstat(numstatOut)
    for (const [path, fileStat] of parseNumstat(cachedOut)) {
      if (!stats.has(path)) stats.set(path, fileStat)
    }

    if (this.cwdValue !== cwd) return this.status()

    const parts = statusOut.split("\0").filter(Boolean)
    const header = parts.shift() ?? ""
    const files: GitFile[] = []
    const untracked: GitFile[] = []
    for (let i = 0; i < parts.length; i += 1) {
      const line = parts[i]
      if (!line || line.length < 4) continue
      const xy = line.slice(0, 2)
      const path = line.slice(3)
      let oldName: string | undefined
      if (xy.includes("R") || xy.includes("C")) {
        oldName = parts[i + 1] ?? path
        i += 1
      }
      const status = statusFor(xy)
      const fileStat = stats.get(path)
      const file: GitFile = {
        path,
        status,
        oldName,
        insertions: fileStat?.insertions ?? 0,
        deletions: fileStat?.deletions ?? 0,
        binary: false,
        staged: xy[0] !== " " && xy[0] !== "?",
      }
      files.push(file)
      if (status === "untracked") untracked.push(file)
    }

    // Untracked files have no HEAD to diff against, so their "insertions"
    // are simply their line count, read once here.
    for (let offset = 0; offset < untracked.length; offset += 16) {
      await Promise.all(
        untracked.slice(offset, offset + 16).map(async (file) => {
          const counted = await countLines(join(root, file.path))
          file.insertions = counted.lines
          file.binary = counted.binary
        })
      )
    }

    return {
      cwd,
      root,
      branch: branchOut.trim() || undefined,
      head: headOut.trim() || undefined,
      upstream: /\.\.\.(\S+)/.exec(header)?.[1],
      ahead: Number(/ahead (\d+)/.exec(header)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(header)?.[1] ?? 0),
      operation: await inProgressOperation(root),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    }
  }

  async listFiles(): Promise<string[] | null> {
    const root = await this.root()
    if (!root) return null
    const [tracked, untracked] = await Promise.all([
      git(root, ["ls-files", "-z"]).catch(() => ""),
      git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).catch(() => ""),
    ])
    return [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean)
  }

  async grep(term: string, options: SearchOptions): Promise<string[]> {
    const root = await this.root()
    if (!root) return []
    const args = ["grep", "--no-color", "-n", "-I", "--untracked"]
    if (!options.caseSensitive) args.push("-i")
    if (options.wholeWord) args.push("-w")
    args.push(options.regex ? "-E" : "-F", "-e", term, "--")
    try {
      const out = await git(root, args)
      return out.split("\n").filter(Boolean)
    } catch {
      // git grep exits 1 when nothing matched, which is not an error.
      return []
    }
  }

  /** Contents for one file — fetched only when the user opens it. */
  async diff(path: string): Promise<GitDiff> {
    const root = await this.root()
    if (!root) return { path, binary: false, oldFile: null, newFile: null }
    const abs = join(root, path)
    const [head, work] = await Promise.all([
      git(root, ["show", `HEAD:${path}`]).catch(() => null),
      readText(abs),
    ])
    return {
      path,
      binary: head === null && work === null && existsSync(abs),
      oldFile: head == null ? null : { name: path, contents: head },
      newFile: work == null ? null : { name: path, contents: work },
    }
  }

  async diffAll(): Promise<{ diffs: GitDiff[]; truncated: number }> {
    const files = (await this.status()).files
    const shown = files.filter((file) => !file.binary).slice(0, 25)
    return {
      diffs: await Promise.all(shown.map((file) => this.diff(file.path))),
      truncated: files.length - shown.length,
    }
  }

  /**
   * One commit, as the files it touched.
   *
   * `diff-tree` twice — numstat for the counts, name-status for what
   * happened — because git offers no single porcelain that carries both.
   */
  async commitFiles(
    hash: string
  ): Promise<Array<{ path: string; status: GitFileStatus; insertions: number; deletions: number; binary: boolean }>> {
    const root = await this.requireRoot()
    const [numstat, names] = await Promise.all([
      git(root, ["diff-tree", "--no-commit-id", "--numstat", "-r", "--root", hash]),
      git(root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", "-M", hash]),
    ])
    const statusOf = new Map<string, GitFileStatus>()
    for (const line of names.split("\n")) {
      const parts = line.split("\t")
      const code = parts[0]?.[0]
      // A rename carries two paths; the new one is what the list shows.
      const path = parts[parts.length - 1]
      if (!code || !path) continue
      statusOf.set(
        path,
        code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified"
      )
    }
    const files: Array<{ path: string; status: GitFileStatus; insertions: number; deletions: number; binary: boolean }> = []
    for (const line of numstat.split("\n")) {
      const [added, removed, ...rest] = line.split("\t")
      const path = rest.join("\t")
      if (!path) continue
      const binary = added === "-"
      files.push({
        path: path.includes(" => ") ? (path.split(" => ").at(-1) ?? path).replace(/}$/, "") : path,
        status: statusOf.get(path) ?? "modified",
        insertions: binary ? 0 : Number(added) || 0,
        deletions: binary ? 0 : Number(removed) || 0,
        binary,
      })
    }
    return files
  }

  /**
   * The whole commit as diffs, ready for the center stage. Capped: a
   *5000-file commit is an archaeology project, not a click.
   */
  async commitDiffAll(hash: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
    const files = await this.commitFiles(hash)
    const shown = files.filter((file) => !file.binary).slice(0, 25)
    const diffs = await Promise.all(shown.map((file) => this.commitFileDiff(hash, file.path)))
    return { diffs, truncated: files.length - shown.length }
  }

  /** A file as one commit changed it: parent's version against the commit's. */
  async commitFileDiff(hash: string, path: string): Promise<GitDiff> {
    const root = await this.requireRoot()
    const [before, after] = await Promise.all([
      git(root, ["show", `${hash}^:${path}`]).catch(() => null),
      git(root, ["show", `${hash}:${path}`]).catch(() => null),
    ])
    return {
      path,
      binary: before === null && after === null,
      oldFile: before == null ? null : { name: path, contents: before },
      newFile: after == null ? null : { name: path, contents: after },
    }
  }

  /**
   * Staging. Paths are workspace-relative and passed after `--` so a file
   * named like a flag can never be read as one.
   */
  async stage(paths: string[]) {
    const root = await this.requireRoot()
    await git(root, ["add", "--", ...paths])
  }

  async unstage(paths: string[]) {
    const root = await this.requireRoot()
    // `reset` fails on a repo with no commits yet; `rm --cached` is the
    // equivalent that works before the first commit exists.
    try {
      await git(root, ["reset", "-q", "HEAD", "--", ...paths])
    } catch {
      await git(root, ["rm", "-q", "--cached", "--", ...paths])
    }
  }

  async stageAll() {
    const root = await this.requireRoot()
    await git(root, ["add", "-A"])
  }

  async unstageAll() {
    const root = await this.requireRoot()
    try {
      await git(root, ["reset", "-q"])
    } catch {
      // No HEAD yet: nothing was ever committed, so unstage everything.
      await git(root, ["rm", "-rq", "--cached", "."]).catch(() => {})
    }
  }

  /**
   * The patch that a commit would record, for review and for the model.
   *
   * A repository with no commits has no HEAD, so `diff HEAD` fails outright —
   * which is the state every freshly-initialized repo is in, and exactly when
   * someone most wants a first commit message drafted. There the index is the
   * only reference, and an empty index still has the untracked files to
   * describe.
   */
  async patch(staged: boolean): Promise<string> {
    const root = await this.requireRoot()
    const hasHead = await git(root, ["rev-parse", "--verify", "HEAD"])
      .then(() => true)
      .catch(() => false)

    if (hasHead) {
      const args = staged ? ["diff", "--cached"] : ["diff", "HEAD"]
      const patch = await git(root, [...args, "--no-color"]).catch(() => "")
      if (patch.trim()) return patch
    } else {
      const patch = await git(root, ["diff", "--cached", "--no-color"]).catch(() => "")
      if (patch.trim()) return patch
    }

    // Nothing diffable: fall back to the list of files that would be added, so
    // an initial commit can still be described.
    const status = await this.status()
    if (status.files.length === 0) return ""
    const lines = status.files
      .slice(0, 400)
      .map((file) => `${file.status}: ${file.path}`)
      .join("\n")
    return `The following files are being added in this commit:\n${lines}`
  }

  async commit(message: string, options: { amend?: boolean } = {}) {
    const root = await this.requireRoot()
    if (!message.trim()) throw new Error("A commit needs a message")
    // Nothing staged means the user meant "commit what I changed".
    if (!(await this.hasStagedChanges()) && !options.amend) {
      await git(root, ["add", "-A"])
    }
    const args = ["commit", "-m", message]
    if (options.amend) args.push("--amend")
    await git(root, args)
  }

  /** Push the current branch, setting upstream on first push. */
  async push(): Promise<{ branch: string; output: string }> {
    const root = await this.requireRoot()
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
    const hasUpstream = await git(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`])
      .then(() => true)
      .catch(() => false)
    const args = hasUpstream ? ["push"] : ["push", "--set-upstream", "origin", branch]
    const output = await git(root, args)
    return { branch, output }
  }

  async log(limit = 60): Promise<GitCommitEntry[]> {
    const root = await this.root()
    if (!root) return []
    // A unit separator keeps subjects containing any punctuation intact.
    const format = ["%H", "%h", "%s", "%an", "%aI"].join("%x1f")
    const out = await git(root, [
      "log",
      `--max-count=${limit}`,
      `--pretty=format:${format}`,
      "--shortstat",
    ]).catch(() => "")

    const entries: GitCommitEntry[] = []
    for (const block of out.split("\n")) {
      const line = block.trim()
      if (!line) continue
      if (line.includes("\x1f")) {
        const [hash, shortHash, subject, author, date] = line.split("\x1f")
        entries.push({ hash, shortHash, subject, author, date, files: 0, insertions: 0, deletions: 0 })
        continue
      }
      // A --shortstat line belongs to the commit just pushed.
      const current = entries.at(-1)
      if (!current) continue
      current.files = Number(/(\d+) files? changed/.exec(line)?.[1] ?? 0)
      current.insertions = Number(/(\d+) insertions?/.exec(line)?.[1] ?? 0)
      current.deletions = Number(/(\d+) deletions?/.exec(line)?.[1] ?? 0)
    }
    return entries
  }

  async hasStagedChanges(): Promise<boolean> {
    const root = await this.requireRoot()
    return git(root, ["diff", "--cached", "--quiet"])
      .then(() => false)
      .catch(() => true)
  }

  private async requireRoot(): Promise<string> {
    const root = await this.root()
    if (!root) throw new Error("This folder is not a git repository")
    return root
  }
}

/** `git diff --numstat -z` emits "adds\tdels\tpath\0"; renames use three fields. */
function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>()
  const fields = output.split("\0")
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field) continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field)
    if (!match) continue
    let path = match[3]
    if (path === "") {
      // Rename: the next two fields are the old path then the new one.
      path = fields[i + 2] ?? fields[i + 1] ?? ""
      i += 2
    }
    stats.set(path, {
      insertions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    })
  }
  return stats
}

/** Merge, rebase, and cherry-pick leave marker files in the git dir. */
async function inProgressOperation(root: string): Promise<string | undefined> {
  const gitDir = join(root, ".git")
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge"
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick"
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert"
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return "rebase"
  }
  return undefined
}
