/**
 * Start the sync daemon at login — opt-in, and honest about the mechanism.
 *
 * A LaunchAgent plist under the user's own ~/Library/LaunchAgents, running
 * the app's binary in Node mode against the daemon script. Nothing is
 * installed system-wide, nothing needs privileges, and removing the toggle
 * removes the file and unloads the job. `KeepAlive` restarts it if it dies;
 * the daemon's own single-instance check makes that safe alongside the app
 * spawning it too — whoever starts first wins, everyone else exits quietly.
 *
 * The plist pins the current binary path, so a moved or updated app should
 * re-save the toggle; the settings surface re-writes it on enable, which in
 * practice is every time someone flips it after an update.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"

const run = promisify(execFile)

const LABEL = "com.mako.syncd"

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
}

function daemonScript(): string {
  return join(app.getAppPath(), "node_modules", "@mako", "sessions", "dist", "daemon-main.js")
}

/** The user said no, once, explicitly. Recorded so the default stays off. */
function optOutPath(): string {
  return join(homedir(), ".mako", "syncd-login-optout")
}

/**
 * Sync-at-login defaults ON: the first boot installs the LaunchAgent
 * quietly, and only an explicit settings opt-out (which writes a marker)
 * keeps it off from then on.
 */
export async function ensureDaemonLoginDefault(): Promise<void> {
  if (process.platform !== "darwin") return
  try {
    if (existsSync(optOutPath())) return
    if (await daemonLoginEnabled()) return
    await setDaemonLogin(true)
  } catch {
    // A failed install stays quiet; the settings toggle still works.
  }
}

export async function daemonLoginEnabled(): Promise<boolean> {
  if (process.platform !== "darwin") return false
  try {
    return (await readFile(plistPath(), "utf8")).includes(LABEL)
  } catch {
    return false
  }
}

export async function setDaemonLogin(enabled: boolean): Promise<void> {
  const { mkdir: makeDir, rm: remove, writeFile: write } = await import("node:fs/promises")
  if (enabled) {
    await remove(optOutPath(), { force: true }).catch(() => {})
  } else {
    await makeDir(join(homedir(), ".mako"), { recursive: true }).catch(() => {})
    await write(optOutPath(), "").catch(() => {})
  }
  if (process.platform !== "darwin") {
    throw new Error("Login start is only wired up for macOS so far")
  }
  const uid = process.getuid?.() ?? 501
  if (!enabled) {
    await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {})
    await rm(plistPath(), { force: true })
    return
  }

  const script = daemonScript()
  if (!existsSync(script)) throw new Error("The daemon script is missing from this build")

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${script}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
  await writeFile(plistPath(), plist, "utf8")
  // Re-bootstrap so a re-save (after an app update moved the binary) takes.
  await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {})
  await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath()]).catch(async (error) => {
    // An unloadable plist should not stay on disk claiming otherwise.
    await rm(plistPath(), { force: true })
    throw new Error(
      `launchctl refused the job: ${error instanceof Error ? error.message : String(error)}`
    )
  })
}
