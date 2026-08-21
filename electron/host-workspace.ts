import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { FileContents, StagedFile, WorkspaceFile } from "./shared.js"
import type { WorkspaceGit } from "./host-git.js"

/**
 * The most of a file the viewer will render.
 *
 * Two megabytes is far past any source file and far short of what freezes a
 * renderer. Above it the head is shown and the viewer says the rest was cut.
 */
const FILE_VIEW_LIMIT = 2_000_000

interface MediaType {
  media: NonNullable<FileContents["media"]>
  mimeType: string
}

const MEDIA_TYPES = {
  ".avif": { media: "image", mimeType: "image/avif" },
  ".gif": { media: "image", mimeType: "image/gif" },
  ".jpeg": { media: "image", mimeType: "image/jpeg" },
  ".jpg": { media: "image", mimeType: "image/jpeg" },
  ".png": { media: "image", mimeType: "image/png" },
  ".svg": { media: "image", mimeType: "image/svg+xml" },
  ".webp": { media: "image", mimeType: "image/webp" },
  ".pdf": { media: "pdf", mimeType: "application/pdf" },
  ".mp3": { media: "audio", mimeType: "audio/mpeg" },
  ".wav": { media: "audio", mimeType: "audio/wav" },
  ".m4a": { media: "audio", mimeType: "audio/mp4" },
  ".mp4": { media: "video", mimeType: "video/mp4" },
  ".mov": { media: "video", mimeType: "video/quicktime" },
  ".webm": { media: "video", mimeType: "video/webm" },
  ".xlsx": {
    media: "spreadsheet",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  ".xls": { media: "spreadsheet", mimeType: "application/vnd.ms-excel" },
  ".numbers": {
    media: "spreadsheet",
    mimeType: "application/vnd.apple.numbers",
  },
} satisfies Record<string, MediaType>

/** The `@` picker re-queries per keystroke; the file set does not move that fast. */
const FILE_CACHE_MS = 5_000

/** Ceilings for the non-git walk, so a stray home directory cannot hang the picker. */
const WALK_MAX_DEPTH = 8
const WALK_MAX_FILES = 20_000
const WALK_SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".venv",
  "venv", "__pycache__", ".cache", "vendor", "Pods", ".turbo", "coverage",
])

export class WorkspaceFiles {
  private cwdValue: string
  private fileCache: { at: number; files: WorkspaceFile[] } | null = null
  private readonly git: WorkspaceGit

  constructor(cwd: string, git: WorkspaceGit) {
    this.cwdValue = cwd
    this.git = git
  }

  get cwd(): string {
    return this.cwdValue
  }

  setCwd(cwd: string) {
    this.cwdValue = cwd
    this.fileCache = null
  }

  /**
   * The workspace file list backing the composer's `@` picker.
   *
   * `git ls-files` is the right source: it already respects .gitignore, so we
   * never walk node_modules. The result is cached for a few seconds because
   * the picker re-queries on every keystroke and the file set does not move
   * that fast.
   */
  async list(): Promise<WorkspaceFile[]> {
    for (;;) {
      const now = Date.now()
      if (this.fileCache && now - this.fileCache.at < FILE_CACHE_MS) return this.fileCache.files

      const cwd = this.cwdValue
      const gitPaths = await this.git.listFiles()
      const paths = gitPaths
        ? gitPaths
        : // Not a repo: a bounded walk, skipping the usual heavy directories.
          await walkWorkspace(cwd, cwd, 0)
      const changed = new Set(
        (await this.git.status().catch(() => null))?.files.map((file) => file.path) ?? []
      )
      const files = paths
        .sort((a, b) => a.localeCompare(b))
        .map((path) => (changed.has(path) ? { path, changed: true } : { path }))

      if (this.cwdValue !== cwd) continue
      this.fileCache = { at: now, files }
      return files
    }
  }

  /**
   * Write an attachment the model cannot take inline into a scratch directory
   * inside the agent dir, and return its path. Engine-owned tools can then reach
   * it, which is the difference between "attach anything" and pretending
   * to.
   */
  async stage(name: string, base64: string): Promise<StagedFile> {
    const dir = join(getAgentDir(), "attachments")
    await mkdir(dir, { recursive: true })
    // Keep the original name legible but collision-free, and never let a name
    // escape the directory it is written into.
    const safe = name.replace(/[/\\]/g, "_").slice(0, 120) || "attachment"
    const stamp = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
    const target = join(dir, `${stamp}-${safe}`)
    const bytes = Buffer.from(base64, "base64")
    await writeFile(target, bytes)
    return { path: target, name: safe, size: bytes.byteLength }
  }

  /**
   * Stage by copying from where the file already is. Drag-and-drop and the
   * file picker know the OS path, so the fast route is a filesystem copy in
   * this process — a 200MB video costs one clonefile-ish copy, not a
   * 270MB base64 string marshalled across the IPC boundary.
   */
  async stagePath(sourcePath: string): Promise<StagedFile> {
    const dir = join(getAgentDir(), "attachments")
    await mkdir(dir, { recursive: true })
    const name = sourcePath.split("/").pop() ?? "attachment"
    const safe = name.replace(/[/\\]/g, "_").slice(0, 120) || "attachment"
    const stamp = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
    const target = join(dir, `${stamp}-${safe}`)
    await copyFile(sourcePath, target)
    const info = await stat(target)
    return { path: target, name: safe, size: info.size }
  }

  /**
   * Read a workspace file for the viewer.
   *
   * Two guards, both about not hanging the window on something it cannot show
   * anyway: a byte ceiling, because a 40MB log renders as a frozen tab, and a
   * NUL check, because a binary opened as text is a screenful of noise that
   * takes longer to draw than to read. Both are reported rather than silently
   * applied — a truncated file that does not say so is a lie about the code.
   */
  async read(path: string): Promise<FileContents> {
    const absolute = await this.resolvePath(path)
    const info = await stat(absolute)
    if (info.isDirectory()) throw new Error(`${path} is a directory`)
    const extension = extname(path).toLowerCase()
    const media = Object.entries(MEDIA_TYPES).find(
      ([candidate]) => candidate === extension
    )?.[1]
    if (media) {
      const encoded = path
        .split(/[\\/]/)
        .map((part) => encodeURIComponent(part))
        .join("/")
      return {
        path,
        contents: "",
        size: info.size,
        binary: true,
        truncated: false,
        media: media.media,
        mimeType: media.mimeType,
        previewUrl: `mako-file://workspace/${encoded}`,
      }
    }

    const handle = await open(absolute, "r")
    try {
      const length = Math.min(info.size, FILE_VIEW_LIMIT)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      // A NUL byte in the first few KB is the same heuristic git uses, and it
      // is right far more often than sniffing extensions.
      if (buffer.subarray(0, 8000).includes(0)) {
        return { path, contents: "", size: info.size, binary: true, truncated: false }
      }
      return {
        path,
        contents: buffer.toString("utf8"),
        size: info.size,
        binary: false,
        truncated: info.size > FILE_VIEW_LIMIT,
      }
    } finally {
      await handle.close()
    }
  }

  /** Absolute path for a workspace-relative one, for reveal/open. */
  async resolvePath(path: string): Promise<string> {
    const root = resolve((await this.git.root()) ?? this.cwdValue)
    const absolute = resolve(root, path)
    const fromRoot = relative(root, absolute)
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error("That path is outside this workspace")
    }
    return absolute
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    const contents = await readFile(path)
    if (contents.includes(0)) return null
    return contents.toString("utf8")
  } catch {
    return null
  }
}

export async function walkWorkspace(root: string, dir: string, depth: number): Promise<string[]> {
  if (depth > WALK_MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkWorkspace(root, full, depth + 1)))
    } else if (entry.isFile()) {
      out.push(relative(root, full))
    }
    if (out.length > WALK_MAX_FILES) break
  }
  return out
}
