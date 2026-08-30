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
 * The plist pins the binary path and Node flags. Startup compares the desired
 * definition with the installed one and refreshes it only when an update moved
 * the app or changed the daemon runtime contract.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"
import { DAEMON_NODE_ARGS } from "./daemon-command.js"

const run = promisify(execFile)

const LABEL = "com.mako.syncd"

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
}

function daemonScript(): string {
  return join(app.getAppPath(), "node_modules", "@mako", "sessions", "dist", "daemon-main.js")
}

function daemonPlist(script = daemonScript()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
${DAEMON_NODE_ARGS.map((argument) => `    <string>${argument}</string>`).join("\n")}
    <string>${script}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>MAKO_DAEMON_VERSION</key><string>${app.getVersion()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
</dict>
</plist>
`
}

/** The user said no, once, explicitly. Recorded so the default stays off. */
function optOutPath(): string {
  return join(homedir(), ".mako", "syncd-login-optout")
}

/**
 * Session sync runs inside the app by default. An existing login job is an
 * explicit always-on choice and is refreshed when its command changes.
 */
export async function refreshDaemonLoginJob(): Promise<void> {
  if (process.platform !== "darwin") return
  try {
    if (existsSync(optOutPath())) return
    const current = await readFile(plistPath(), "utf8").catch(() => null)
    if (!current || current === daemonPlist()) return
    await setDaemonLogin(true)
  } catch {
    // A failed install stays quiet; the settings toggle still works.
  }
}

export async function daemonLoginProcess(): Promise<number | null> {
  if (process.platform !== "darwin") return null
  const uid = process.getuid?.() ?? 501
  try {
    const { stdout } = await run("launchctl", [
      "print",
      `gui/${uid}/${LABEL}`,
    ])
    const match = /\bpid = (\d+)/.exec(stdout)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

export async function stopDaemonLoginJob(): Promise<void> {
  if (process.platform !== "darwin") return
  const uid = process.getuid?.() ?? 501
  await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {})
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

  const plist = daemonPlist(script)
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
  await writeFile(plistPath(), plist, "utf8")
  // Re-bootstrap so a re-save (after an app update moved the binary) takes.
  await run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {})
  let failure: Error | null = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await run("launchctl", ["bootstrap", `gui/${uid}`, plistPath()])
      return
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
  // An unloadable plist should not stay on disk claiming otherwise.
  await rm(plistPath(), { force: true })
  throw new Error(`launchctl refused the job: ${failure?.message ?? "unknown error"}`)
}
