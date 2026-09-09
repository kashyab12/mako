import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { collectCommitPatch } from "../electron/commit-patch.ts"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-commit-generation-"))
const signal = AbortSignal.timeout(30_000)
const git = (...args: string[]) => run("git", args, { cwd: root })
try {
  await git("init", "-q")
  await assert.rejects(collectCommitPatch(root, signal), /no changes/)
  await writeFile(join(root, "first.txt"), "First commit content\n")
  await writeFile(join(root, ".env"), "PRIVATE_TEST_VALUE=do-not-send\n")
  let patch = await collectCommitPatch(root, signal)
  assert.equal(patch.scope, "working-tree")
  assert.match(patch.text, /First commit content/)
  assert.doesNotMatch(patch.text, /do-not-send/)
  assert.ok(patch.warnings.length)
  await git("add", "first.txt")
  await writeFile(
    join(root, "first.txt"),
    "Unstaged content must not be sent\n"
  )
  patch = await collectCommitPatch(root, signal)
  assert.equal(patch.scope, "staged")
  assert.match(patch.text, /First commit content/)
  assert.doesNotMatch(patch.text, /Unstaged content|PRIVATE_TEST_VALUE/)
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "Initial"
  )
  await writeFile(join(root, "second.txt"), "New untracked feature\n")
  patch = await collectCommitPatch(root, signal)
  assert.match(patch.text, /Unstaged content/)
  assert.match(patch.text, /New untracked feature/)
  await writeFile(join(root, "large.txt"), "Large diff line\n".repeat(60_000))
  await writeFile(join(root, "z-last.txt"), "Do not crowd out this change\n")
  await symlink(join(root, ".env"), join(root, "link.txt"))
  patch = await collectCommitPatch(root, signal)
  assert.ok(patch.text.length < 2_100_000)
  assert.match(patch.text, /Do not crowd out this change/)
  assert.doesNotMatch(patch.text, /do-not-send/)
  assert.ok(patch.warnings.some((warning) => warning.includes("large.txt")))
  assert.equal(
    await readFile(join(root, "first.txt"), "utf8"),
    "Unstaged content must not be sent\n"
  )
  assert.equal((await git("diff", "--cached")).stdout, "")
  await mkdir(join(root, "nested"))
  await writeFile(join(root, "nested", "feature.txt"), "Nested content\n")
  await writeFile(join(root, "binary.dat"), Buffer.from([1, 0, 2]))
  patch = await collectCommitPatch(join(root, "nested"), signal)
  assert.match(patch.text, /New untracked feature/)
  assert.match(patch.text, /Nested content/)
  assert.match(patch.text, /Added binary file/)
  await git("mv", "first.txt", "renamed.txt")
  patch = await collectCommitPatch(root, signal)
  assert.equal(patch.scope, "staged")
  assert.match(patch.text, /renamed.txt/)
  assert.match(patch.text, /deleted file mode/)
  assert.doesNotMatch(patch.text, /New untracked feature/)
  await assert.rejects(collectCommitPatch(root, AbortSignal.abort()), /abort/i)
  console.log(
    "Commit patch: unborn HEAD, staged-only, untracked, sensitive files, symlinks, large files, cancellation passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
