import { app } from "electron"
import { mkdirSync, watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Where plugins live on disk.
 *
 * `userData`, not the app bundle. A packaged app's resources are read-only and
 * on macOS are inside a signed bundle — writing there would either fail or
 * break the signature. userData is writable in every build, which is the whole
 * point: the agent must be able to change this app after it ships, not only
 * when it is running from a checkout.
 */
export function pluginsDir() {
  return join(app.getPath("userData"), "plugins")
}

export interface PluginFile {
  id: string
  source: string
}

/** Read every plugin, newest-name-first order being irrelevant here. */
export async function listPlugins(): Promise<PluginFile[]> {
  const dir = pluginsDir()
  await mkdir(dir, { recursive: true })
  const names = (await readdir(dir)).filter((name) => /\.(tsx|ts|jsx|js)$/.test(name))

  const files = await Promise.all(
    names.map(async (name) => {
      try {
        return { id: name.replace(/\.\w+$/, ""), source: await readFile(join(dir, name), "utf8") }
      } catch {
        return null
      }
    })
  )
  return files.filter((file): file is PluginFile => file !== null)
}

export async function writePlugin(id: string, source: string) {
  const dir = pluginsDir()
  await mkdir(dir, { recursive: true })
  // The id is a bare name, never a path: a plugin called `../../etc/passwd`
  // must land in the plugins directory as a strange filename, not outside it.
  await writeFile(join(dir, `${safe(id)}.tsx`), source, "utf8")
}

function safe(id: string) {
  return id.replace(/[^\w.-]/g, "-").replace(/^\.+/, "")
}

/**
 * Watch for changes and report which plugin changed.
 *
 * This is what closes the loop: the agent writes a file with its ordinary
 * `write` tool — it needs to know nothing about Mako's IPC — and the window
 * re-evaluates that plugin a moment later. Debounced because an editor or an
 * agent writing a file commonly produces several events for one save.
 */
export function watchPlugins(onChange: () => void): FSWatcher | null {
  try {
    // Created before watching, not after. `fs.watch` on a missing directory
    // throws, and the first run is exactly when the directory is missing — so
    // arming the watcher first meant the feature never worked until the second
    // launch, silently.
    const dir = pluginsDir()
    mkdirSync(dir, { recursive: true })

    let timer: NodeJS.Timeout | undefined
    return watch(dir, () => {
      clearTimeout(timer)
      timer = setTimeout(onChange, 80)
    })
  } catch {
    return null
  }
}
