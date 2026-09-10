import type { Comparison, KiriClient, KiriRepository, RepoPath } from "@kiri/client"
import type { GitDiff } from "./shared.js"

export async function readGitPreview(repo: KiriRepository, client: KiriClient, path: string, bytes: RepoPath, comparison: Comparison): Promise<GitDiff> {
  const result = await client.request({ method: "compare", repo: repo.id, path: bytes, comparison })
  if (result.kind !== "compared") throw new Error("Kiri returned an invalid comparison result")
  const preview = result.preview
  switch (preview.kind) {
    case "files": return { path, binary: false, oldFile: preview.before == null ? null : { name: path, contents: preview.before }, newFile: preview.after == null ? null : { name: path, contents: preview.after } }
    case "binary": return { path, binary: true, oldFile: null, newFile: null }
    case "patch": return { path, binary: false, oldFile: null, newFile: null, preview: { kind: "patch", contents: preview.patch, limited: preview.limited } }
    case "unavailable": return { path, binary: false, oldFile: null, newFile: null, preview: { kind: "unavailable", reason: preview.reason } }
  }
}

export async function readGitPreviewSet(files: ReadonlyArray<{ path: string }>, load: (path: string) => Promise<GitDiff>): Promise<{ diffs: GitDiff[]; truncated: number }> {
  const diffs: GitDiff[] = []
  const deadline = Date.now() + 5_000
  let bytes = 0
  for (const file of files) {
    if (diffs.length >= 25 || bytes >= 512 * 1024 || Date.now() >= deadline) break
    const diff = await load(file.path)
    bytes += Buffer.byteLength(diff.oldFile?.contents ?? "") + Buffer.byteLength(diff.newFile?.contents ?? "") + Buffer.byteLength(diff.preview?.kind === "patch" ? diff.preview.contents : "")
    diffs.push(diff)
  }
  return { diffs, truncated: files.length - diffs.length }
}
