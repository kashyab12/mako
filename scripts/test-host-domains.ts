import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { WorkspaceGit } from "../electron/host-git.ts"
import { searchWorkspace } from "../electron/host-search.ts"
import { WorkspaceFiles } from "../electron/host-workspace.ts"

const execFileAsync = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "mako-host-domains-"))
const firstRepo = join(directory, "first")
const secondRepo = join(directory, "second")
const remote = join(directory, "remote.git")

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd })
  return stdout.trim()
}

async function initializeRepo(path: string) {
  await mkdir(path)
  await git(path, "init", "-b", "main")
  await git(path, "config", "user.name", "Mako Test")
  await git(path, "config", "user.email", "mako@example.test")
}

try {
  await initializeRepo(firstRepo)
  await mkdir(remote)
  await git(remote, "init", "--bare")
  await writeFile(join(firstRepo, "tracked.txt"), "alpha needle\n")
  await git(firstRepo, "add", "tracked.txt")
  await git(firstRepo, "commit", "-m", "Initial commit")
  await git(firstRepo, "remote", "add", "origin", remote)

  const workspaceGit = new WorkspaceGit(firstRepo)
  const workspaceFiles = new WorkspaceFiles(firstRepo, workspaceGit)

  await writeFile(join(firstRepo, "tracked.txt"), "alpha needle\nchanged line\n")
  const diff = await workspaceGit.diff("tracked.txt")
  assert.equal(diff.oldFile?.contents, "alpha needle\n")
  assert.equal(diff.newFile?.contents, "alpha needle\nchanged line\n")
  const allDiffs = await workspaceGit.diffAll()
  assert.equal(allDiffs.diffs.length, 1)
  assert.equal(allDiffs.diffs[0]?.path, "tracked.txt")
  assert.equal(allDiffs.truncated, 0)

  await workspaceGit.stage(["tracked.txt"])
  assert.equal((await workspaceGit.status()).files.find((file) => file.path === "tracked.txt")?.staged, true)
  await workspaceGit.unstage(["tracked.txt"])
  assert.equal((await workspaceGit.status()).files.find((file) => file.path === "tracked.txt")?.staged, false)

  await git(firstRepo, "mv", "tracked.txt", "renamed.txt")
  await writeFile(join(firstRepo, "notes.txt"), "untracked needle\n")
  const status = await workspaceGit.status()
  const renamed = status.files.find((file) => file.status === "renamed")
  assert.ok(renamed)
  assert.equal(renamed.oldName, "tracked.txt")
  assert.equal(renamed.path, "renamed.txt")
  assert.equal(status.files.find((file) => file.path === "notes.txt")?.status, "untracked")

  const listed = await workspaceFiles.list()
  assert.equal(listed.some((file) => file.path === "renamed.txt"), true)
  assert.equal(listed.some((file) => file.path === "notes.txt"), true)
  assert.equal((await workspaceFiles.read("notes.txt")).contents, "untracked needle\n")

  const searched = await searchWorkspace(
    firstRepo,
    workspaceGit,
    async () => [],
    "needle",
    { threads: false }
  )
  assert.equal(searched.files.some((file) => file.path === "renamed.txt"), true)
  assert.equal(searched.files.some((file) => file.path === "notes.txt"), true)

  await workspaceGit.stageAll()
  assert.equal((await workspaceGit.status()).files.every((file) => file.staged), true)
  await workspaceGit.commit("Rename tracked file")
  const log = await workspaceGit.log()
  assert.equal(log[0]?.subject, "Rename tracked file")
  assert.equal((await workspaceGit.commitFiles(log[0]?.hash ?? "")).length > 0, true)

  const pushed = await workspaceGit.push()
  assert.equal(pushed.branch, "main")
  assert.equal(
    await git(directory, `--git-dir=${remote}`, "rev-parse", "refs/heads/main"),
    log[0]?.hash
  )

  await initializeRepo(secondRepo)
  await writeFile(join(secondRepo, "second.txt"), "second workspace\n")
  workspaceGit.setCwd(firstRepo)
  workspaceFiles.setCwd(firstRepo)
  const pendingRoot = workspaceGit.root()
  const pendingFiles = workspaceFiles.list()
  workspaceGit.setCwd(secondRepo)
  workspaceFiles.setCwd(secondRepo)
  const [, switchedFiles] = await Promise.all([pendingRoot, pendingFiles])
  assert.deepEqual(switchedFiles.map((file) => file.path), ["second.txt"])
  const secondFiles = await workspaceFiles.list()
  assert.deepEqual(secondFiles.map((file) => file.path), ["second.txt"])
  assert.equal((await workspaceGit.status()).root, await realpath(secondRepo))
  assert.equal(secondFiles.some((file) => file.path === "renamed.txt"), false)
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log("host git, workspace, search, and cache checks passed")
