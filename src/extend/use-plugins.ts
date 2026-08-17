import { useEffect } from "react"
import { getPi, hasBridge } from "@/lib/bridge"
import { loadPlugin, plugins, unloadPlugin } from "@/extend/plugin-host"

/**
 * Keeps the loaded plugins in step with the plugins directory.
 *
 * Loaded once at boot and re-loaded whenever the host says a file changed —
 * which happens when the agent writes one with its ordinary tools. Nothing in
 * the loop is development-only: it is the same in a packaged build, which is
 * the entire reason this exists rather than leaning on the bundler's hot
 * replacement.
 */
export function usePlugins() {
  useEffect(() => {
    if (!hasBridge()) return
    const pi = getPi()

    let live = true

    const sync = async () => {
      const files = await pi.listPlugins().catch(() => [])
      if (!live) return

      const present = new Set(files.map((file) => file.id))
      // A plugin whose file is gone must give its registrations back, or a
      // deleted plugin would keep a command in the palette until restart.
      for (const [id] of plugins.entries()) {
        if (!present.has(id)) unloadPlugin(id)
      }

      for (const file of files) {
        // Unchanged source is skipped: re-evaluating a module that did not
        // change would tear down and rebuild its contributions for nothing,
        // which is visible as a flicker in whatever slot it renders into.
        if (plugins.get(file.id)?.source === file.source) continue
        await loadPlugin(file.id, file.source)
      }
    }

    void sync()
    const unsubscribe = pi.onEvent((event) => {
      if (event.type === "plugins-changed") void sync()
    })

    return () => {
      live = false
      unsubscribe()
    }
  }, [])
}
