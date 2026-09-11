import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Which URLs a hidden desk window may show. The window carries Mako's
 * privileged preload, so only the desk document itself qualifies: the dev
 * server's exact origin, or the packaged bundle's exact index file. A suffix
 * match would let any local `dist/index.html` borrow the host bridge.
 */
export function deskUrlPolicy(options: {
  devServerUrl: string | null
  indexFile: string | null
}): (url: string) => boolean {
  const devOrigin = options.devServerUrl
    ? new URL(options.devServerUrl).origin
    : null
  const indexPath = options.indexFile ? resolve(options.indexFile) : null
  return (url) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.href === "about:blank") return true
    if (devOrigin !== null) return parsed.origin === devOrigin
    if (parsed.protocol !== "file:" || indexPath === null) return false
    try {
      return resolve(fileURLToPath(parsed)) === indexPath
    } catch {
      return false
    }
  }
}
