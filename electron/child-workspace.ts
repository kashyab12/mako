import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  copyFile,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"

const execute = promisify(execFile)
export interface ChildWorkspace {
  kind: "git-worktree" | "copy"
  path: string
  source: string
  revision?: string
}
async function git(
  cwd: string,
  args: string[],
  env = process.env
): Promise<string> {
  const { stdout } = await execute("git", args, {
    cwd,
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trim()
}

/** Each delegated writer receives its own captured files. The parent's index and branch never move. */
export async function prepareChildWorkspace(
  root: string,
  id: string,
  source: string
): Promise<ChildWorkspace> {
  await mkdir(root, { recursive: true })
  const canonicalRoot = await realpath(root)
  const destination = join(canonicalRoot, "child-workspaces", id)
  const receipt = join(root, "child-workspaces", `${id}.json`)
  await mkdir(dirname(destination), { recursive: true })
  const existing = await readFile(receipt, "utf8").catch(() => null)
  if (existing) {
    const { ChildWorkspaceSchema } =
      await import("./contracts/conversation-control.js")
    const workspace = ChildWorkspaceSchema.parse(JSON.parse(existing))
    if (workspace.source !== source)
      throw new Error("This workspace receipt belongs to another source")
    await lstat(workspace.path)
    return workspace
  }
  const canonicalSource = await realpath(source)
  const repository = await git(canonicalSource, [
    "rev-parse",
    "--show-toplevel",
  ]).catch(() => null)
  let workspace: ChildWorkspace
  if (repository) {
    const temporary = await mkdtemp(join(tmpdir(), "mako-child-index-"))
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(temporary, "index"),
      GIT_AUTHOR_NAME: "Mako",
      GIT_AUTHOR_EMAIL: "mako@localhost",
      GIT_COMMITTER_NAME: "Mako",
      GIT_COMMITTER_EMAIL: "mako@localhost",
    }
    try {
      const head = await git(repository, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]).catch(() => null)
      await git(
        repository,
        head ? ["read-tree", head] : ["read-tree", "--empty"],
        env
      )
      await git(repository, ["add", "-A", "--", "."], env)
      const tree = await git(repository, ["write-tree"], env)
      const revision = await git(
        repository,
        [
          "commit-tree",
          tree,
          ...(head ? ["-p", head] : []),
          "-m",
          `Mako child snapshot ${id}`,
        ],
        env
      )
      await git(repository, [
        "worktree",
        "add",
        "--detach",
        destination,
        revision,
      ])
      workspace = {
        kind: "git-worktree",
        path: join(destination, relative(repository, canonicalSource)),
        source,
        revision,
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  } else {
    const canonicalDestination = resolve(destination)
    let bytes = 0
    let files = 0
    async function copy(directory: string, target: string): Promise<void> {
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (
          resolve(path) === canonicalDestination ||
          path === canonicalRoot ||
          path === join(canonicalRoot, "child-workspaces")
        )
          continue
        if (["node_modules", ".git", ".DS_Store"].includes(entry.name)) continue
        if (entry.isSymbolicLink())
          throw new Error(
            `Cannot isolate a workspace containing symlink ${path}`
          )
        if (entry.isDirectory()) await copy(path, join(target, entry.name))
        else if (entry.isFile()) {
          const info = await lstat(path)
          bytes += info.size
          files += 1
          if (bytes > 256 * 1024 * 1024 || files > 20_000)
            throw new Error("The child workspace exceeds the snapshot limit")
          await copyFile(path, join(target, entry.name))
        }
      }
    }
    await copy(canonicalSource, destination)
    workspace = { kind: "copy", path: destination, source }
  }
  const pendingReceipt = `${receipt}.${randomUUID()}.tmp`
  await writeFile(pendingReceipt, JSON.stringify(workspace), { mode: 0o600 })
  const { rename } = await import("node:fs/promises")
  await rename(pendingReceipt, receipt)
  return workspace
}
