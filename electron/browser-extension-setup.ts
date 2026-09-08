import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

export interface BrowserExtensionSetup {
  directory: string
  extensionId: string
}

const manifestSchema = z.object({ key: z.string().min(1) })
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Register the native helper only for this extension, and materialize its reviewable files. */
export async function prepareBrowserExtension(
  appPath: string,
  executable: string,
  home = homedir()
): Promise<BrowserExtensionSetup> {
  if (process.platform === "win32")
    throw new Error("Browser extension setup is not yet available on Windows")
  const source = join(appPath, "dist-browser-extension")
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(source, "manifest.json"), "utf8"))
  )
  const extensionId = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (value) =>
      String.fromCharCode(97 + parseInt(value, 16))
    )
  const directory = join(home, ".mako", "browser-extension-package")
  const bin = join(home, ".mako", "bin")
  await mkdir(bin, { recursive: true, mode: 0o700 })
  await cp(source, directory, { recursive: true })
  const helper = join(bin, "mako-browser-host")
  const temporary = `${helper}.${process.pid}.tmp`
  await writeFile(
    temporary,
    `#!/bin/sh\nexec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(join(appPath, "dist-electron", "browser-native-host-entry.js"))} "$@"\n`,
    { mode: 0o700 }
  )
  await chmod(temporary, 0o700)
  await rename(temporary, helper)
  const base =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : join(home, ".config")
  const profiles =
    process.platform === "darwin"
      ? [
          "Google/Chrome",
          "Google/ChromeForTesting",
          "Microsoft Edge",
          "BraveSoftware/Brave-Browser",
          "Chromium",
        ]
      : [
          "google-chrome",
          "google-chrome-for-testing",
          "microsoft-edge",
          "BraveSoftware/Brave-Browser",
          "chromium",
        ]
  for (const profile of profiles) {
    if (!existsSync(join(base, profile))) continue
    const hosts = join(base, profile, "NativeMessagingHosts")
    await mkdir(hosts, { recursive: true })
    await writeFile(
      join(hosts, "dev.mako.browser.json"),
      JSON.stringify(
        {
          name: "dev.mako.browser",
          description: "Mako Browser",
          path: helper,
          type: "stdio",
          allowed_origins: [`chrome-extension://${extensionId}/`],
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  }
  return { directory, extensionId }
}
