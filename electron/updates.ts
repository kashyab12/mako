import { app } from "electron"
import type { HostEvent, UpdateState } from "./shared.js"
import { record } from "./crash.js"

/**
 * Updates.
 *
 * Two rules shape this, and both are about not interrupting a running agent:
 *
 *   * **Never restart on its own.** A turn can be minutes long and involve real
 *     edits to real files. An update that relaunches the app underneath that is
 *     not an improvement. Downloading is automatic; installing is a decision,
 *     and the decision is the user's.
 *   * **Say nothing when there is nothing to say.** No "you are up to date"
 *     toast on every launch. The status is available on request; it does not
 *     announce itself unless there is genuinely a new version.
 *
 * `electron-updater` is loaded lazily so a dev run — where there is no update
 * feed and never will be — does not pay for it at boot.
 */

type Updater = typeof import("electron-updater").autoUpdater

let updater: Updater | null = null
let state: UpdateState = { status: "idle", version: app.getVersion() }
let emit: (event: HostEvent) => void = () => {}

function publish(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  emit({ type: "update", update: state })
}

export function updateState(): UpdateState {
  return state
}

/**
 * Load the updater, once.
 *
 * Returns null in development and in any build without a publish feed, which
 * is not a failure — it is the normal case for someone running from a
 * checkout, and the UI reads it as "updates do not apply here".
 */
async function load(): Promise<Updater | null> {
  if (updater) return updater
  if (!app.isPackaged) return null
  try {
    const module = await import("electron-updater")
    // The package is CJS; the default export is what carries `autoUpdater`.
    const auto = (module.autoUpdater ?? module.default?.autoUpdater) as Updater | undefined
    if (!auto) return null

    auto.autoDownload = true
    // The one thing that must never happen without being asked.
    auto.autoInstallOnAppQuit = false

    auto.on("checking-for-update", () => publish({ status: "checking", error: undefined }))
    auto.on("update-not-available", () => publish({ status: "current", error: undefined }))
    auto.on("update-available", (info) =>
      publish({ status: "downloading", available: info.version, progress: 0, error: undefined })
    )
    auto.on("download-progress", (progress) =>
      publish({ status: "downloading", progress: Math.round(progress.percent) })
    )
    auto.on("update-downloaded", (info) =>
      publish({ status: "ready", available: info.version, progress: 100, notes: notesFrom(info) })
    )
    auto.on("error", (error) => {
      // An update that cannot be fetched is not a crash and must not read like
      // one — the app works fine on the version it already has.
      publish({ status: "error", error: error.message })
    })

    updater = auto
    return auto
  } catch (error) {
    record("main-uncaught", error, "electron-updater")
    return null
  }
}

function notesFrom(info: { releaseNotes?: string | Array<{ note: string | null }> | null }) {
  const notes = info.releaseNotes
  if (typeof notes === "string") return notes.replace(/<[^>]+>/g, "").trim().slice(0, 4000)
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => entry.note ?? "")
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim()
      .slice(0, 4000)
  }
  return undefined
}

export function installUpdates(send: (event: HostEvent) => void) {
  emit = send
  if (!app.isPackaged) {
    state = { status: "unsupported", version: app.getVersion() }
    return
  }
  // A check at launch, then every six hours. More often than that is polling
  // GitHub for something that changes a few times a week.
  void check()
  setInterval(() => void check(), 6 * 60 * 60 * 1000).unref?.()
}

export async function check(): Promise<UpdateState> {
  const auto = await load()
  if (!auto) {
    publish({ status: app.isPackaged ? "current" : "unsupported" })
    return state
  }
  try {
    await auto.checkForUpdates()
  } catch (error) {
    publish({ status: "error", error: error instanceof Error ? error.message : String(error) })
  }
  return state
}

/** Relaunch into the downloaded version. Only ever called from a click. */
export async function installNow() {
  const auto = await load()
  if (!auto || state.status !== "ready") return
  // `isSilent: true, isForceRunAfter: true` — no installer UI, and the app
  // comes back rather than leaving the user staring at a closed window.
  auto.quitAndInstall(true, true)
}
