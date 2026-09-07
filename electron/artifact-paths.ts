import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { realpath } from "node:fs/promises"

/** Mako-owned artifact roots are distinct from the workspace/git boundary. */
export async function resolveMakoArtifact(
  path: string
): Promise<string | null> {
  if (!isAbsolute(path)) return null
  const absolute = await realpath(path).catch(() => null)
  if (!absolute) return null
  for (const folder of ["attachments", "transcripts", "artifacts"]) {
    const root = await realpath(join(homedir(), ".mako", folder)).catch(
      () => null
    )
    if (!root) continue
    const child = relative(root, absolute)
    if (
      child &&
      child !== ".." &&
      !child.startsWith(`..${sep}`) &&
      !isAbsolute(child)
    )
      return absolute
  }
  return null
}
