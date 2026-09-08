import { readFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BrowserFault } from "./contracts/browser-control.js"
import { extensionBrowsers } from "./browser-extension-registration.js"

export interface LocalBrowser {
  id: string
  name: string
  endpoint: () => Promise<string>
  requiresApproval?: boolean
}

export function localBrowsers(): LocalBrowser[] {
  const extensions = extensionBrowsers()
  if (process.env.MAKO_LEGACY_BROWSER_DEBUGGING !== "1") return extensions
  const home = homedir()
  const locations =
    process.platform === "darwin"
      ? [
          [
            "chrome",
            "Google Chrome",
            join(home, "Library/Application Support/Google/Chrome"),
          ],
          [
            "edge",
            "Microsoft Edge",
            join(home, "Library/Application Support/Microsoft Edge"),
          ],
          [
            "brave",
            "Brave",
            join(
              home,
              "Library/Application Support/BraveSoftware/Brave-Browser"
            ),
          ],
          [
            "chromium",
            "Chromium",
            join(home, "Library/Application Support/Chromium"),
          ],
        ]
      : process.platform === "win32"
        ? [
            [
              "chrome",
              "Google Chrome",
              join(
                process.env.LOCALAPPDATA ?? join(home, "AppData/Local"),
                "Google/Chrome/User Data"
              ),
            ],
            [
              "edge",
              "Microsoft Edge",
              join(
                process.env.LOCALAPPDATA ?? join(home, "AppData/Local"),
                "Microsoft/Edge/User Data"
              ),
            ],
          ]
        : [
            ["chrome", "Google Chrome", join(home, ".config/google-chrome")],
            ["chromium", "Chromium", join(home, ".config/chromium")],
            ["edge", "Microsoft Edge", join(home, ".config/microsoft-edge")],
          ]
  return [...extensions, ...locations
    .filter(([, , directory]) => existsSync(directory))
    .map(([id, name, directory]) => ({
      id,
      name,
      endpoint: async () => {
        try {
          const file = join(directory, "DevToolsActivePort")
          if ((await stat(file)).size > 4096)
            throw new Error("Invalid endpoint file")
          const [port, path] = (await readFile(file, "utf8"))
            .trim()
            .split(/\r?\n/)
          if (
            !/^\d+$/.test(port) ||
            Number(port) < 1 ||
            Number(port) > 65535 ||
            !/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(path)
          )
            throw new Error("Invalid endpoint file")
          return `ws://127.0.0.1:${port}${path}`
        } catch {
          throw new BrowserFault({
            code: "unavailable",
            message: `Open ${name} and enable remote debugging at chrome://inspect/#remote-debugging, then connect. Mako retains the connection across tasks.`,
            outcome: "not-dispatched",
          })
        }
      },
    }))]
}
