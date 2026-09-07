import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { prepareChildWorkspace } from "../electron/child-workspace.ts"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-isolation-"))
const repo = join(root, "repo")
await mkdir(repo)
async function git(...args: string[]) {
  return (await run("git", args, { cwd: repo })).stdout.trim()
}
try {
  await git("init")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@localhost")
  await writeFile(join(repo, "tracked.txt"), "original")
  await git("add", ".")
  await git("commit", "-m", "fixture")
  await writeFile(join(repo, "tracked.txt"), "staged")
  await git("add", ".")
  await writeFile(join(repo, "tracked.txt"), "unstaged")
  await writeFile(join(repo, "new.txt"), "untracked fixture")
  const before = await git("status", "--porcelain=v1")
  const head = await git("rev-parse", "HEAD")
  const index = await git("write-tree")
  const firstId = randomUUID()
  const first = await prepareChildWorkspace(root, firstId, repo)
  const second = await prepareChildWorkspace(root, randomUUID(), repo)
  assert.equal(first.kind, "git-worktree")
  assert.equal(
    await readFile(join(first.path, "tracked.txt"), "utf8"),
    "unstaged"
  )
  assert.equal(
    await readFile(join(first.path, "new.txt"), "utf8"),
    "untracked fixture"
  )
  await writeFile(join(first.path, "tracked.txt"), "child one")
  await writeFile(join(second.path, "tracked.txt"), "child two")
  assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "unstaged")
  assert.equal(
    await readFile(join(first.path, "tracked.txt"), "utf8"),
    "child one"
  )
  assert.equal(
    await readFile(join(second.path, "tracked.txt"), "utf8"),
    "child two"
  )
  assert.equal(await git("status", "--porcelain=v1"), before)
  assert.equal(await git("rev-parse", "HEAD"), head)
  assert.equal(await git("write-tree"), index)
  assert.deepEqual(await prepareChildWorkspace(root, firstId, repo), first)
  const plain = join(root, "plain")
  await mkdir(plain)
  await writeFile(join(plain, "proof.txt"), "original")
  const copied = await prepareChildWorkspace(root, randomUUID(), plain)
  await writeFile(join(copied.path, "proof.txt"), "child")
  assert.equal(await readFile(join(plain, "proof.txt"), "utf8"), "original")
  console.log(
    "Child workspace isolation passed: staged/unstaged/untracked capture, independent siblings, unchanged parent index/HEAD/files, receipt reuse, non-Git snapshots"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
