import { execFile, spawn } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, readlink } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const MAX_FILES = 1_000
const MAX_PATCH_BYTES = 2_000_000
const MAX_FILE_BYTES = 128_000
const sensitivePath =
  /(^|\/)(\.env(?:\..*)?|\.credentials(?:\..*)?|credentials\.json|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx))$/i
const generatedPath =
  /(^|\/)(package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|[^/]+\.min\.[^/]+)$/i

export interface CommitPatch {
  text: string
  scope: "staged" | "working-tree"
  files: number
  warnings: string[]
}

export async function collectCommitPatch(
  cwd: string,
  signal: AbortSignal
): Promise<CommitPatch> {
  const git = async (...args: string[]) => {
    signal.throwIfAborted()
    const result = await run("git", args, {
      cwd,
      signal,
      timeout: 30_000,
      maxBuffer: 2_000_000,
    })
    return result.stdout
  }
  const root = (await git("rev-parse", "--show-toplevel")).trim()
  const stagedPaths = (
    await git(
      "-C",
      root,
      "diff",
      "--cached",
      "--no-renames",
      "--name-only",
      "-z"
    )
  )
    .split("\0")
    .filter(Boolean)
  const staged = stagedPaths.length > 0
  const tracked = staged
    ? stagedPaths
    : (await git("-C", root, "diff", "--no-renames", "--name-only", "-z"))
        .split("\0")
        .filter(Boolean)
  const untracked = staged
    ? []
    : (
        await git(
          "-C",
          root,
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z"
        )
      )
        .split("\0")
        .filter(Boolean)
  const paths = [...new Set([...tracked, ...untracked])]
  if (paths.length > MAX_FILES)
    throw new Error(
      "More than 1,000 files changed. Stage a smaller group before drafting a message."
    )
  if (!paths.length) throw new Error("There are no changes to describe.")
  const fileBudget = Math.min(
    MAX_FILE_BYTES,
    Math.floor(MAX_PATCH_BYTES / paths.length)
  )
  const untrackedSet = new Set(untracked)
  const sections: string[] = []
  const warnings: string[] = []
  for (let offset = 0; offset < paths.length; offset += 4) {
    signal.throwIfAborted()
    const batch = await Promise.all(
      paths.slice(offset, offset + 4).map(async (path) => {
        const heading = `File: ${JSON.stringify(path)}\n`
        if (sensitivePath.test(path))
          return {
            text: `${heading}[Sensitive file contents omitted]`,
            warning: `Sensitive file omitted: ${path}`,
          }
        const limit = generatedPath.test(path)
          ? Math.min(4_000, fileBudget)
          : fileBudget
        const contents = untrackedSet.has(path)
          ? await readUntracked(join(root, path), limit, signal)
          : await readDiff(root, path, staged, limit, signal)
        return {
          text:
            heading +
            contents.text +
            (contents.truncated ? "\n[Remaining file content omitted]" : ""),
          warning: contents.truncated ? `Partial content: ${path}` : undefined,
        }
      })
    )
    for (const entry of batch) {
      sections.push(entry.text)
      if (entry.warning) warnings.push(entry.warning)
    }
  }
  return {
    text: sections.join("\n\n"),
    scope: staged ? "staged" : "working-tree",
    files: paths.length,
    warnings,
  }
}

async function readUntracked(path: string, limit: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const info = await lstat(path)
  if (info.isSymbolicLink())
    return {
      text: `Added symbolic link to ${await readlink(path)}`,
      truncated: false,
    }
  if (!info.isFile()) return { text: "[Not a regular file]", truncated: false }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    signal.throwIfAborted()
    const sample = buffer.subarray(0, Math.min(bytesRead, limit))
    return {
      text: sample.includes(0)
        ? "[Added binary file]"
        : sample.toString("utf8"),
      truncated: bytesRead > limit,
    }
  } finally {
    await file.close()
  }
}

function readDiff(
  root: string,
  path: string,
  staged: boolean,
  limit: number,
  signal: AbortSignal
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--unified=3",
    ]
    if (staged) args.push("--cached")
    args.push("--", path)
    const child = spawn("git", args, {
      cwd: root,
      signal,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let truncated = false
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = limit - bytes
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining)
        chunks.push(kept)
        bytes += kept.length
      }
      if (chunk.length > remaining) {
        truncated = true
        child.kill()
      }
    })
    child.once("error", reject)
    child.once("close", (code) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      if (code !== 0 && !truncated) {
        reject(
          new Error(
            "Git could not read the diff. Refresh Changes and try again."
          )
        )
        return
      }
      resolve({
        text: Buffer.concat(chunks, bytes).toString("utf8"),
        truncated,
      })
    })
  })
}
