import { app, desktopCapturer, shell, systemPreferences } from "electron"
import { packagedDistribution } from "./distribution.js"
import type { MakoComputerPermissions } from "./shared.js"

export function computerPermissions(): MakoComputerPermissions {
  if (process.platform !== "darwin") {
    return {
      supported: false,
      persistentAcrossUpdates: false,
      accessibility: false,
      screenRecording: "unknown",
    }
  }
  return {
    supported: true,
    persistentAcrossUpdates:
      !app.isPackaged || packagedDistribution(app.getAppPath()) === "signed",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus("screen"),
  }
}

async function openPrivacyPane(
  pane: "Privacy_Accessibility" | "Privacy_ScreenCapture"
): Promise<void> {
  await shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${pane}`
  )
}

export async function requestComputerPermissions(
  focus: () => void
): Promise<MakoComputerPermissions> {
  if (process.platform !== "darwin") return computerPermissions()
  focus()
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const permissions = computerPermissions()
    if (!permissions.accessibility)
      await openPrivacyPane("Privacy_Accessibility")
    return permissions
  }
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    await desktopCapturer
      .getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      })
      .catch(() => [])
    const permissions = computerPermissions()
    if (permissions.screenRecording !== "granted")
      await openPrivacyPane("Privacy_ScreenCapture")
    return permissions
  }
  return computerPermissions()
}
